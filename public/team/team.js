'use strict';

const state = {
  sessionId: null,
  tavoloId: null,
  token: null,
  socket: null,
  azioni: {},
  azioniSistemiche: {},
  categorieClassificazione: [],
  fasiConfig: null,
  ultimoStato: null,
  timerInterval: null
};

const el = (id) => document.getElementById(id);
const ETICHETTE_STAT = {
  competenza: 'Competenza', autonomia: 'Autonomia', motivazione: 'Motivazione',
  resilienza: 'Resilienza', velocitaApprendimento: 'Velocità apprendimento', risultati: 'Risultati'
};
const ETICHETTE_FASE = { 2: 'Fase 2', 3: 'Fase 3 — Crisi', 4: 'Fase 4' };

// Le tre stat mostrate come barre con freccia di tendenza (niente numeri: solo cio' che si
// puo' dedurre dalla lunghezza della barra e dalla direzione della freccia). L'ordine qui
// e' anche l'ordine di visualizzazione sulla scheda.
const ETICHETTE_BARRA = { autonomia: 'Autonomia', motivazione: 'Motivazione', competenza: 'Competenza' };
const FRECCIA_TREND = { su: '▲', giu: '▼', stabile: '→' };

function renderStelle(n) {
  const piene = Math.max(0, Math.min(5, n || 0));
  return '★'.repeat(piene) + '☆'.repeat(5 - piene);
}

// Riempie il contenitore ".barre-stat-collaboratore" con le barre di Autonomia/Motivazione/
// Competenza, ciascuna con la propria freccia di tendenza (assente finche' non c'e' abbastanza
// storia, es. alla prima settimana giocata).
function renderBarreStat(container, c) {
  container.innerHTML = '';
  const trend = c.trend || {};
  Object.entries(ETICHETTE_BARRA).forEach(([campo, etichetta]) => {
    const valore = c.stats ? c.stats[campo] : undefined;
    if (valore === undefined) return;
    const direzione = trend[campo];
    const freccia = direzione ? `<span class="freccia-trend ${direzione}">${FRECCIA_TREND[direzione]}</span>` : '';
    const riga = document.createElement('div');
    riga.className = 'riga-barra-stat';
    riga.innerHTML = `
      <div class="barra-stat-label"><span>${etichetta}</span>${freccia}</div>
      <div class="barra-track"><div class="barra-fill" style="width:${valore}%"></div></div>
    `;
    container.appendChild(riga);
  });
}

function mostraSchermata(nome) {
  document.querySelectorAll('.schermata').forEach((s) => s.classList.add('hidden'));
  el(nome).classList.remove('hidden');
}

async function caricaConfigPubblico() {
  const res = await fetch('/config/pubblico');
  const config = await res.json();
  state.azioni = config.azioni;
  state.azioniSistemiche = config.azioniSistemiche;
  state.categorieClassificazione = config.categorieClassificazione;
  state.fasiConfig = config.fasi;
}

function mostraErroreAccesso(msg) {
  const p = el('erroreAccesso');
  p.textContent = msg;
  p.classList.remove('hidden');
}

// ---------- Banner fluttuante (eventi del facilitatore) ----------

let timerBanner = null;
function mostraBannerFluttuante(testo) {
  const banner = el('bannerFluttuante');
  banner.querySelector('.banner-fluttuante-testo').textContent = testo;
  banner.classList.remove('hidden');
  clearTimeout(timerBanner);
  timerBanner = setTimeout(() => banner.classList.add('hidden'), 12000);
}
el('bannerFluttuante').querySelector('.banner-fluttuante-chiudi').addEventListener('click', () => {
  el('bannerFluttuante').classList.add('hidden');
});

async function entraInGioco(sessionId, tavoloId, token) {
  state.sessionId = sessionId;
  state.tavoloId = tavoloId;
  state.token = token;
  if (!token) {
    return mostraErroreAccesso('Link o codice non validi: manca il token di accesso al tavolo.');
  }
  await caricaConfigPubblico();

  state.socket = io();
  state.socket.on('connect', () => {
    state.socket.emit('tavolo:join', { sessionId, tavoloId, tok: state.token });
  });
  state.socket.on('errore', (e) => mostraErroreAccesso(e.messaggio || 'Errore di connessione'));
  state.socket.on('tavolo:stato', (vista) => {
    state.ultimoStato = vista;
    renderStato(vista);
  });
  state.socket.on('tavolo:erroreAzione', (e) => {
    alert(e.messaggio + (e.oreResidue !== undefined ? ` (ore residue: ${e.oreResidue})` : ''));
  });
  state.socket.on('evento:ricevuto', (evento) => {
    mostraBannerFluttuante(`${evento.titolo}: ${evento.testo}`);
  });
}

// ---------- Accesso ----------

const params = new URLSearchParams(window.location.search);
const sParam = params.get('s');
const tParam = params.get('t');
const tokParam = params.get('tok');

if (sParam && tParam) {
  entraInGioco(sParam, tParam, tokParam);
} else {
  el('btnAccedi').addEventListener('click', async () => {
    const sessionId = el('inputSessionId').value.trim();
    const codice = el('inputCodice').value.trim().toUpperCase();
    if (!sessionId || !codice) return mostraErroreAccesso('Inserisci ID sessione e codice tavolo');

    try {
      const res = await fetch(`/api/sessioni/${sessionId}/resolve-codice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ codice })
      });
      if (!res.ok) {
        const err = await res.json();
        return mostraErroreAccesso(err.errore || 'Codice non valido');
      }
      const { tavoloId, token } = await res.json();
      entraInGioco(sessionId, tavoloId, token);
    } catch (err) {
      mostraErroreAccesso('Sessione non raggiungibile');
    }
  });
}

// ---------- Render ----------

function renderStato(vista) {
  el('nomeTavoloBadge').textContent = vista.nome;
  el('nomeTavoloBadge').classList.remove('hidden');

  el('overlayPausa').classList.toggle('hidden', !vista.inPausa);

  // Fase 3: la crisi cambia il "mood" di tutta la scrivania (sfondo piu' caldo),
  // non solo un banner — si "sente" anche visivamente, non solo nei numeri.
  document.body.classList.toggle('crisi-attiva', vista.statoSessione === 'in_round' && vista.faseCorrente === 3);

  if (vista.statoSessione === 'fase1_classificazione') {
    clearInterval(state.timerInterval);
    el('overlayRichiestaTelefono').classList.add('hidden');
    el('overlayCronologia').classList.add('hidden');
    renderFase1Team(vista);
    return;
  }

  if (vista.statoSessione === 'terminata') {
    clearInterval(state.timerInterval);
    el('overlayRichiestaTelefono').classList.add('hidden');
    el('overlayCronologia').classList.add('hidden');
    renderFinale(vista);
    return;
  }

  if (vista.statoSessione === 'in_round') {
    renderGioco(vista);
  } else {
    clearInterval(state.timerInterval);
    el('overlayRichiestaTelefono').classList.add('hidden');
    el('overlayCronologia').classList.add('hidden');
    renderAttesa(vista);
  }
}

function renderFase1Team(vista) {
  const griglia = el('grigliaClassificazione');
  const template = el('templateClassificazione');
  griglia.innerHTML = '';

  vista.collaboratori.forEach((c) => {
    const nodo = template.content.cloneNode(true);
    nodo.querySelector('.nome-collaboratore').textContent = c.nome;
    nodo.querySelector('.stelle-overall').textContent = renderStelle(c.stelle);
    renderBarreStat(nodo.querySelector('.barre-stat-collaboratore'), c);

    const select = nodo.querySelector('.select-categoria');
    popolaSelectCategoria(select, c.categoriaAssegnata);
    select.addEventListener('change', () => {
      state.socket.emit('tavolo:classificaCollaboratore', {
        sessionId: state.sessionId, tavoloId: state.tavoloId, collaboratoreId: c.id, categoria: select.value
      });
    });

    griglia.appendChild(nodo);
  });

  mostraSchermata('schermataFase1Team');
}

function popolaSelectCategoria(select, valoreSelezionato) {
  select.innerHTML = '';
  const optDefault = document.createElement('option');
  optDefault.value = '';
  optDefault.textContent = '— classifica —';
  select.appendChild(optDefault);
  state.categorieClassificazione.forEach((categoria) => {
    const opt = document.createElement('option');
    opt.value = categoria;
    opt.textContent = categoria;
    if (categoria === valoreSelezionato) opt.selected = true;
    select.appendChild(opt);
  });
}

function renderAttesa(vista) {
  el('roundAttesaCorrente').textContent = vista.roundCorrente;
  el('roundAttesaTotale').textContent = vista.numeroRound;
  el('titoloAttesa').textContent = vista.statoSessione === 'round_chiuso'
    ? `Settimana ${vista.roundCorrente - 1} chiusa — in attesa della prossima settimana`
    : 'In attesa che il facilitatore avvii la settimana';

  const cardMessaggi = el('cardMessaggiAttesa');
  if ((vista.messaggiNarrativiRound || []).length > 0) {
    cardMessaggi.innerHTML = vista.messaggiNarrativiRound.map((m) => `<p>${m.testo}</p>`).join('');
    cardMessaggi.classList.remove('hidden');
  } else {
    cardMessaggi.classList.add('hidden');
  }

  const cardImpatto = el('cardImpattoCrisi');
  if (vista.impattoCrisi && vista.impattoCrisi.round === vista.roundCorrente - 1) {
    cardImpatto.innerHTML = `<h3>🔥 Impatto della crisi</h3><p class="muted">${vista.impattoCrisi.testo}</p>`;
    cardImpatto.classList.remove('hidden');
  } else {
    cardImpatto.classList.add('hidden');
  }

  mostraSchermata('schermataAttesa');
}

function renderGioco(vista) {
  el('roundGiocoCorrente').textContent = vista.roundCorrente;
  el('roundGiocoTotale').textContent = vista.numeroRound;
  el('climaTeamValore').textContent = vista.climaTeam;
  el('faseBadgeTeam').textContent = ETICHETTE_FASE[vista.faseCorrente] || `Fase ${vista.faseCorrente}`;

  const inCrisi = vista.faseCorrente === 3;
  el('bannerCrisiTeam').classList.toggle('hidden', !inCrisi);
  if (inCrisi && state.fasiConfig) {
    el('testoCrisiTeam').textContent = state.fasiConfig.crisi.testo;
  }

  const oreResidue = vista.oreDisponibiliRound - vista.oreUsateRound;
  el('oreResidue').textContent = oreResidue;
  el('oreTotali').textContent = vista.oreDisponibiliRound;
  const percentualeUsata = Math.round((vista.oreUsateRound / vista.oreDisponibiliRound) * 100);
  const fill = el('oreProgressFill');
  fill.style.width = `${100 - percentualeUsata}%`;
  fill.classList.toggle('warn', oreResidue <= 1);

  aggiornaTimerTeam(vista);

  renderCollaboratori(vista);

  const cardSistemiche = el('cardAzioniSistemiche');
  cardSistemiche.classList.toggle('hidden', vista.faseCorrente !== 4);
  if (vista.faseCorrente === 4) renderAzioniSistemiche(vista);

  renderTelefono(vista);
  renderCruscotto(vista);
  renderAgenda(vista);

  el('confermatoLabel').classList.toggle('hidden', !vista.confermato);
  el('btnConfermaRound').classList.toggle('hidden', vista.confermato);
  el('cardLockAttivo').classList.toggle('hidden', !vista.confermato);

  mostraSchermata('schermataGioco');
}

// ---------- La "scrivania": navigazione tra le 4 zone ----------

document.querySelectorAll('.zona-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.zona-btn').forEach((b) => b.classList.remove('attiva'));
    btn.classList.add('attiva');
    document.querySelectorAll('.zona-scrivania').forEach((z) => z.classList.add('hidden'));
    const zona = btn.dataset.zona;
    el('zona' + zona.charAt(0).toUpperCase() + zona.slice(1)).classList.remove('hidden');
  });
});

// ---------- Zona Telefono: richieste in arrivo come notifiche ----------

function renderTelefono(vista) {
  el('telefonoRoundLabel').textContent = vista.roundCorrente;

  const conRichiesta = vista.collaboratori.filter((c) => c.richiestaCorrente && !c.uscitoDallaRete);
  const senzaRisposta = conRichiesta.filter((c) => !vista.azioniSottomesseRound[c.id]);

  const badge = el('badgeTelefono');
  badge.textContent = senzaRisposta.length;
  badge.classList.toggle('hidden', senzaRisposta.length === 0);

  const lista = el('listaNotifiche');
  if (conRichiesta.length === 0) {
    lista.innerHTML = '<div class="notifica-vuota">Nessuna notifica questa settimana. Dai un\'occhiata a Team o Cruscotto.</div>';
    return;
  }

  lista.innerHTML = conRichiesta.map((c) => {
    const azioneRisposta = vista.azioniSottomesseRound[c.id];
    return `
      <div class="notifica-item${azioneRisposta ? ' risposta-data' : ''}" data-id="${c.id}">
        ${azioneRisposta ? '<div class="notifica-check-badge">✓</div>' : ''}
        <div class="notifica-avatar">👤</div>
        <div class="notifica-testo">
          <div class="notifica-nome">${c.nome}</div>
          <div class="notifica-anteprima">${c.richiestaCorrente.testo}</div>
          ${azioneRisposta ? `<span class="notifica-tag-risposta">✓ Gestito: ${state.azioni[azioneRisposta].label}</span>` : ''}
        </div>
      </div>
    `;
  }).join('');

  lista.querySelectorAll('.notifica-item').forEach((nodo) => {
    nodo.addEventListener('click', () => {
      const c = vista.collaboratori.find((x) => x.id === nodo.dataset.id);
      if (c) apriRichiestaOverlay(c, vista);
    });
  });
}

function apriRichiestaOverlay(c, vista) {
  const overlay = el('overlayRichiestaTelefono');
  const box = el('overlayRichiestaContenuto');
  const azioneGiaAssegnata = vista.azioniSottomesseRound[c.id];

  box.innerHTML = `
    <h2>${c.nome.toUpperCase()}</h2>
    <div class="sottotitolo">🔔 ${c.richiestaCorrente.testo}</div>
    <div style="font-size:0.85rem;color:var(--gold-300);margin-bottom:10px;">Cosa fai?</div>
    <div class="opzioni-azione" id="opzioniAzioneTelefono">
      ${Object.entries(state.azioni).map(([azioneId, def]) => `
        <label class="opzione-riga">
          <input type="radio" name="azioneTelefono" value="${azioneId}" data-ore="${def.costoOre}" ${azioneId === azioneGiaAssegnata ? 'checked' : ''} />
          <span>${def.label}</span>
          <span style="margin-left:auto;color:var(--text-muted);font-size:0.75rem;">${def.costoOre}h</span>
        </label>
      `).join('')}
    </div>
    <div class="tempo-richiesto">Tempo richiesto: <strong id="oreSelezionateTelefono">${azioneGiaAssegnata ? state.azioni[azioneGiaAssegnata].costoOre + 'h' : '—'}</strong></div>
    <button class="btn btn-primario" id="btnConfermaTelefono" style="width:100%;margin-bottom:8px;" ${azioneGiaAssegnata ? '' : 'disabled'}>Conferma</button>
    <button class="btn-chiudi-overlay" id="btnChiudiTelefono">Annulla</button>
  `;
  overlay.classList.remove('hidden');

  const radios = box.querySelectorAll('input[name="azioneTelefono"]');
  const btnConferma = el('btnConfermaTelefono');
  radios.forEach((r) => r.addEventListener('change', () => {
    el('oreSelezionateTelefono').textContent = r.dataset.ore + 'h';
    btnConferma.disabled = false;
  }));

  el('btnChiudiTelefono').addEventListener('click', () => overlay.classList.add('hidden'));
  btnConferma.addEventListener('click', () => {
    const scelto = box.querySelector('input[name="azioneTelefono"]:checked');
    if (!scelto || !scelto.value) return;
    state.socket.emit('tavolo:submitAzione', {
      sessionId: state.sessionId,
      tavoloId: state.tavoloId,
      collaboratoreId: c.id,
      azioneId: scelto.value
    });
    mostraAckTelefono(c, scelto.value);
  });
}

function mostraAckTelefono(c, azioneId) {
  const box = el('overlayRichiestaContenuto');
  const def = state.azioni[azioneId];
  box.innerHTML = `
    <h2>${c.nome.toUpperCase()}</h2>
    <div class="narrativa">✓ Prenotato: <strong>${def.label}</strong> (${def.costoOre}h). Lo trovi anche in Agenda.</div>
    <button class="btn btn-primario" id="btnChiudiAckTelefono" style="width:100%;">Torna al telefono</button>
  `;
  el('btnChiudiAckTelefono').addEventListener('click', () => el('overlayRichiestaTelefono').classList.add('hidden'));
}

// ---------- Overlay Cronologia: aperto cliccando su una scheda collaboratore in zona Team ----------
// Mostra lo storico leggibile del collaboratore e, solo dalla prima settimana di Fase 2 in poi
// (in Fase 1 i collaboratori "non fanno ancora nulla"), un selettore di intervento che richiede un
// click esplicito su "Conferma" — niente tendina che sottomette da sola al cambio.
function apriCronologia(c, vista) {
  const overlay = el('overlayCronologia');
  const box = el('overlayCronologiaContenuto');
  const cronologia = (c.cronologia || []).slice().reverse();

  const timelineHtml = cronologia.length
    ? `<div class="timeline-mini">${cronologia.map((voce) => `
        <div class="timeline-mini-item">
          <span class="ic">${voce.gestita ? '✓' : '•'}</span>
          <span>
            <span class="rnd">Settimana ${voce.round}</span><br/>
            ${voce.richiesta ? `${voce.richiesta} — ` : ''}${voce.azioneLabel}
          </span>
        </div>
      `).join('')}</div>`
    : '<div class="cronologia-vuota">Nessuna cronologia ancora: aspetta la chiusura della prima settimana.</div>';

  const azioneAttivabile = vista.faseCorrente >= 2 && !c.uscitoDallaRete && !vista.confermato;
  const azioneGiaAssegnata = vista.azioniSottomesseRound[c.id];

  const azionePickerHtml = azioneAttivabile ? `
    <hr class="separatore-cronologia" />
    <div style="font-size:0.85rem;color:var(--gold-300);margin-bottom:10px;">Scegli un intervento per questa settimana</div>
    <div class="opzioni-azione" id="opzioniAzioneCronologia">
      ${Object.entries(state.azioni).map(([azioneId, def]) => `
        <label class="opzione-riga">
          <input type="radio" name="azioneCronologia" value="${azioneId}" data-ore="${def.costoOre}" ${azioneId === azioneGiaAssegnata ? 'checked' : ''} />
          <span>${def.label}</span>
          <span style="margin-left:auto;color:var(--text-muted);font-size:0.75rem;">${def.costoOre}h</span>
        </label>
      `).join('')}
    </div>
    <div class="tempo-richiesto">Tempo richiesto: <strong id="oreSelezionateCronologia">${azioneGiaAssegnata ? state.azioni[azioneGiaAssegnata].costoOre + 'h' : '—'}</strong></div>
    <button class="btn btn-primario" id="btnConfermaCronologia" style="width:100%;margin-bottom:8px;" ${azioneGiaAssegnata ? '' : 'disabled'}>Conferma</button>
  ` : (vista.faseCorrente < 2 ? '<p class="muted" style="font-size:0.78rem;margin-top:12px;">In Fase 1 non si assegnano ancora interventi: per ora si classifica soltanto.</p>' : '');

  box.innerHTML = `
    <h2>${c.nome.toUpperCase()}</h2>
    <div class="sottotitolo">${renderStelle(c.stelle)}</div>
    ${timelineHtml}
    ${azionePickerHtml}
    <button class="btn-chiudi-overlay" id="btnChiudiCronologia">Chiudi</button>
  `;
  overlay.classList.remove('hidden');

  if (azioneAttivabile) {
    const radios = box.querySelectorAll('input[name="azioneCronologia"]');
    const btnConferma = el('btnConfermaCronologia');
    radios.forEach((r) => r.addEventListener('change', () => {
      el('oreSelezionateCronologia').textContent = r.dataset.ore + 'h';
      btnConferma.disabled = false;
    }));
    btnConferma.addEventListener('click', () => {
      const scelto = box.querySelector('input[name="azioneCronologia"]:checked');
      if (!scelto || !scelto.value) return;
      state.socket.emit('tavolo:submitAzione', {
        sessionId: state.sessionId,
        tavoloId: state.tavoloId,
        collaboratoreId: c.id,
        azioneId: scelto.value
      });
      overlay.classList.add('hidden');
    });
  }

  el('btnChiudiCronologia').addEventListener('click', () => overlay.classList.add('hidden'));
}

// ---------- Zona Cruscotto: KPI della rete, non del singolo collaboratore ----------

function renderCruscotto(vista) {
  const oreResidue = vista.oreDisponibiliRound - vista.oreUsateRound;
  const percentualeOre = vista.oreDisponibiliRound > 0 ? Math.round((oreResidue / vista.oreDisponibiliRound) * 100) : 0;
  const richiedonoAttenzione = vista.collaboratori.filter((c) => c.richiestaCorrente && !c.uscitoDallaRete && !vista.azioniSottomesseRound[c.id]);

  el('grigliaKpiCruscotto').innerHTML = `
    <div class="kpi-card">
      <div class="kpi-label">😊 Clima rete</div>
      <div class="kpi-valore">${vista.climaTeam}</div>
      <div class="kpi-sub">su 100</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">⏱ Ore disponibili</div>
      <div class="kpi-valore">${oreResidue}/${vista.oreDisponibiliRound}</div>
      <div class="progress-bar-track" style="margin-top:6px;"><div class="progress-bar-fill" style="width:${percentualeOre}%"></div></div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">📅 Fase e settimana</div>
      <div class="kpi-valore" style="font-size:1.15rem;">${ETICHETTE_FASE[vista.faseCorrente] || `Fase ${vista.faseCorrente}`}</div>
      <div class="kpi-sub">Settimana ${vista.roundCorrente}/${vista.numeroRound}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">⚠ Richiedono attenzione</div>
      <div class="kpi-valore">${richiedonoAttenzione.length}</div>
      <div class="kpi-sub">non ancora gestite</div>
    </div>
  `;
}

// ---------- Zona Agenda: ore disponibili e azioni gia' pianificate ----------

function renderAgenda(vista) {
  const oreResidue = vista.oreDisponibiliRound - vista.oreUsateRound;
  el('agendaOreResidue').textContent = oreResidue;
  el('agendaOreTotali').textContent = vista.oreDisponibiliRound;
  const percentuale = vista.oreDisponibiliRound > 0 ? Math.round((oreResidue / vista.oreDisponibiliRound) * 100) : 0;
  el('agendaBarraOre').style.width = `${percentuale}%`;

  const righe = [];
  Object.entries(vista.azioniSottomesseRound || {}).forEach(([collaboratoreId, azioneId]) => {
    if (!azioneId) return;
    const c = vista.collaboratori.find((x) => x.id === collaboratoreId);
    const def = state.azioni[azioneId];
    if (!c || !def) return;
    righe.push({ chi: c.nome, cosa: def.label, ore: def.costoOre });
  });
  (vista.azioniSistemicheSottomesseRound || []).forEach((azioneId) => {
    const def = state.azioniSistemiche[azioneId];
    if (!def) return;
    righe.push({ chi: 'Rete (azione sistemica)', cosa: def.label, ore: def.costoOre });
  });

  const box = el('agendaListaAzioni');
  if (righe.length === 0) {
    box.innerHTML = '<div class="agenda-vuota">Ancora nessuna azione pianificata per questa settimana: apri il Telefono per rispondere alle richieste.</div>';
    return;
  }
  box.innerHTML = righe.map((r) => `
    <div class="agenda-azione-riga">
      <div><span class="chi">${r.chi}</span> — <span class="cosa">${r.cosa}</span></div>
      <div>${r.ore}h</div>
    </div>
  `).join('');
}

function aggiornaTimerTeam(vista) {
  clearInterval(state.timerInterval);
  const box = el('timerRoundTeam');
  if (!vista.roundIniziatoIl || !vista.durataRoundSecondi) {
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');
  const tick = () => {
    const scadenza = vista.roundIniziatoIl + vista.durataRoundSecondi * 1000;
    const residuoSec = Math.max(0, Math.round((scadenza - Date.now()) / 1000));
    const mm = String(Math.floor(residuoSec / 60)).padStart(2, '0');
    const ss = String(residuoSec % 60).padStart(2, '0');
    el('timerRoundTeamValore').textContent = `${mm}:${ss}`;
    box.classList.toggle('scaduto', residuoSec === 0);
  };
  tick();
  if (!vista.inPausa) {
    state.timerInterval = setInterval(tick, 1000);
  }
}

el('btnSbloccaConferma').addEventListener('click', () => {
  state.socket.emit('tavolo:sbloccaConferma', { sessionId: state.sessionId, tavoloId: state.tavoloId });
});

function renderCollaboratori(vista) {
  const griglia = el('grigliaCollaboratori');
  const template = el('templateCollaboratore');
  griglia.innerHTML = '';

  vista.collaboratori.forEach((c) => {
    const nodo = template.content.cloneNode(true);
    const card = nodo.querySelector('.collaboratore-card');
    card.classList.toggle('uscito', !!c.uscitoDallaRete);

    nodo.querySelector('.nome-collaboratore').textContent = c.uscitoDallaRete ? `${c.nome} (uscito dalla rete)` : c.nome;
    nodo.querySelector('.stelle-overall').textContent = renderStelle(c.stelle);
    renderBarreStat(nodo.querySelector('.barre-stat-collaboratore'), c);

    const selectCategoria = nodo.querySelector('.select-categoria');
    popolaSelectCategoria(selectCategoria, c.categoriaAssegnata);
    selectCategoria.addEventListener('change', () => {
      state.socket.emit('tavolo:classificaCollaboratore', {
        sessionId: state.sessionId, tavoloId: state.tavoloId, collaboratoreId: c.id, categoria: selectCategoria.value
      });
    });

    const richiestaEl = nodo.querySelector('.richiesta-inline');
    if (c.richiestaCorrente) {
      richiestaEl.textContent = `Chiede: ${c.richiestaCorrente.testo}`;
      richiestaEl.classList.remove('nessuna');
    } else {
      richiestaEl.textContent = 'Nessuna richiesta questa settimana';
      richiestaEl.classList.add('nessuna');
    }

    const azioneAssegnata = vista.azioniSottomesseRound[c.id];
    const azioneLabel = nodo.querySelector('.azione-corrente');
    azioneLabel.textContent = azioneAssegnata
      ? `Azione scelta: ${state.azioni[azioneAssegnata].label} (${state.azioni[azioneAssegnata].costoOre}h)`
      : 'Nessuna azione ancora scelta';

    if (c.uscitoDallaRete) {
      selectCategoria.disabled = true;
    }

    // La scheda e' cliccabile per aprire la cronologia (dove si trova anche, da Fase 2 in poi,
    // il selettore di intervento a click). Il click sulla tendina "classifica" non deve aprire
    // la cronologia: qui sotto lo escludiamo esplicitamente.
    card.addEventListener('click', (event) => {
      if (event.target.closest('.select-categoria')) return;
      apriCronologia(c, vista);
    });

    griglia.appendChild(nodo);
  });
}

function renderAzioniSistemiche(vista) {
  const griglia = el('grigliaAzioniSistemiche');
  griglia.innerHTML = '';
  const selezionate = vista.azioniSistemicheSottomesseRound || [];

  Object.entries(state.azioniSistemiche).forEach(([azioneId, def]) => {
    const btn = document.createElement('button');
    btn.className = 'azione-sistemica-toggle' + (selezionate.includes(azioneId) ? ' selezionata' : '');
    btn.innerHTML = `<span class="titolo">${def.label}</span><span class="costo">${def.costoOre}h — ${def.descrizione}</span>`;
    btn.disabled = !!vista.confermato;
    btn.addEventListener('click', () => {
      state.socket.emit('tavolo:submitAzioneSistemica', { sessionId: state.sessionId, tavoloId: state.tavoloId, azioneSistemicaId: azioneId });
    });
    griglia.appendChild(btn);
  });
}

el('btnConfermaRound').addEventListener('click', () => {
  state.socket.emit('tavolo:confermaRound', { sessionId: state.sessionId, tavoloId: state.tavoloId });
});

function renderFinale(vista) {
  if (vista.risultatoFinale) {
    el('posizioneFinale').textContent = `${vista.risultatoFinale.posizione}° posto`;
    el('punteggioFinale').textContent = vista.risultatoFinale.punteggioTotale;
  }
  if (vista.profilo) {
    el('profiloLabel').textContent = vista.profilo.profiloPrincipale.label;
    el('profiloDescrizione').textContent = vista.profilo.profiloPrincipale.descrizione;
    el('profiloTendenza').textContent = vista.profilo.tendenzaSecondaria.label;
  }
  if (vista.epilogo) {
    el('epilogoTitolo').textContent = vista.epilogo.titolo;
    el('epilogoTesto').textContent = vista.epilogo.testo;
    el('cardEpilogoFinale').classList.remove('hidden');
  }
  mostraSchermata('schermataFinaleTeam');
}
