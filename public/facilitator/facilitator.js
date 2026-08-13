'use strict';

const state = {
  sessionId: null,
  token: null,
  socket: null,
  ultimoStato: null,
  eventiDisponibili: [],
  azioni: {},
  azioniSistemiche: {},
  fasiConfig: null,
  timerInterval: null
};

// ---------- Token facilitatore: salvato in localStorage per riaprire la regia dallo
// stesso browser senza doverlo ritrascrivere a mano (ma non e' condiviso altrove). ----------
const CHIAVE_TOKEN_LOCALSTORAGE = 'lessismore.facilitatoreTokens';

function salvaTokenLocale(sessionId, token) {
  try {
    const mappa = JSON.parse(localStorage.getItem(CHIAVE_TOKEN_LOCALSTORAGE) || '{}');
    mappa[sessionId] = token;
    localStorage.setItem(CHIAVE_TOKEN_LOCALSTORAGE, JSON.stringify(mappa));
  } catch (err) { /* localStorage non disponibile: nessun impatto sul gioco in corso */ }
}

function leggiTokenLocale(sessionId) {
  try {
    const mappa = JSON.parse(localStorage.getItem(CHIAVE_TOKEN_LOCALSTORAGE) || '{}');
    return mappa[sessionId] || null;
  } catch (err) {
    return null;
  }
}

function etichettaAzione(azioneId) {
  return (state.azioni[azioneId] && state.azioni[azioneId].label) || azioneId;
}

function etichettaAzioneSistemica(azioneSistemicaId) {
  return (state.azioniSistemiche[azioneSistemicaId] && state.azioniSistemiche[azioneSistemicaId].label) || azioneSistemicaId;
}

// Restituisce le righe del log di un tavolo (azioni individuali + azioni sistemiche)
// ordinate per round, con i nomi gia' risolti (il log grezzo contiene solo gli id).
function righeLogTavolo(tavolo) {
  const nomiCollaboratori = {};
  tavolo.collaboratori.forEach((c) => { nomiCollaboratori[c.id] = c.nome; });

  const righeIndividuali = (tavolo.log || []).map((voce) => ({
    round: voce.round,
    nomeCollaboratore: nomiCollaboratori[voce.collaboratoreId] || voce.collaboratoreId,
    cluster: voce.cluster,
    azioneLabel: etichettaAzione(voce.azioneId),
    costoOre: voce.costoOre
  }));

  const righeSistemiche = (tavolo.azioniSistemicheLog || []).map((voce) => ({
    round: voce.round,
    nomeCollaboratore: 'Squadra (azione sistemica)',
    cluster: null,
    azioneLabel: etichettaAzioneSistemica(voce.azioneSistemicaId),
    costoOre: (state.azioniSistemiche[voce.azioneSistemicaId] && state.azioniSistemiche[voce.azioneSistemicaId].costoOre) || ''
  }));

  return righeIndividuali.concat(righeSistemiche).sort((a, b) => {
    if (a.round !== b.round) return a.round - b.round;
    return a.nomeCollaboratore.localeCompare(b.nomeCollaboratore);
  });
}

function renderTabellaLog(corpoTabellaEl, tavolo) {
  const righe = righeLogTavolo(tavolo);
  if (righe.length === 0) {
    corpoTabellaEl.innerHTML = '<tr><td colspan="5" class="muted">Ancora nessuna decisione registrata.</td></tr>';
    return;
  }
  corpoTabellaEl.innerHTML = righe.map((r) => `
    <tr>
      <td>S${r.round}</td><td>${r.nomeCollaboratore}</td>
      <td>${r.cluster ? `<span class="cluster-tag ${r.cluster}">${etichettaCluster(r.cluster)}</span>` : '—'}</td>
      <td>${r.azioneLabel}</td><td>${r.costoOre ? r.costoOre + 'h' : ''}</td>
    </tr>
  `).join('');
}

// Mini grafico a barre "richieste al manager" per round, riusato in regia live e nel debrief finale.
function renderGraficoRichieste(container, tavoli) {
  const tavoliConDati = tavoli.filter((t) => (t.storicoRichieste || []).length > 0);
  if (tavoliConDati.length === 0) {
    container.classList.add('hidden');
    return;
  }
  container.classList.remove('hidden');
  const griglia = container.querySelector('.griglia-grafici-richieste') || container;
  const massimo = Math.max(1, ...tavoliConDati.flatMap((t) => t.storicoRichieste.map((s) => s.numeroRichieste)));
  griglia.innerHTML = tavoliConDati.map((t) => `
    <div class="mini-grafico-richieste">
      <div class="titolo-tavolo">${t.nome}</div>
      <div class="barre">
        ${t.storicoRichieste.map((s) => `
          <div class="barra-col">
            <div class="barra" style="height:${Math.max(2, Math.round((s.numeroRichieste / massimo) * 60))}px"></div>
            <div class="barra-lbl">S${s.round}</div>
          </div>
        `).join('')}
      </div>
    </div>
  `).join('');
}

const el = (id) => document.getElementById(id);

function mostraSchermata(nomeSchermata) {
  document.querySelectorAll('.schermata').forEach((s) => s.classList.add('hidden'));
  el(nomeSchermata).classList.remove('hidden');
}

// ---------- Toast: notifiche non bloccanti al posto di alert() ----------
function mostraToast(messaggio, tipo = 'info') {
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = `toast toast-${tipo}`;
  toast.textContent = messaggio;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add('toast-uscita');
    setTimeout(() => toast.remove(), 250);
  }, 4000);
}

// ---------- Creazione sessione ----------

el('btnCreaSessione').addEventListener('click', async () => {
  const nome = el('inputNomeSessione').value.trim();
  const numeroTavoli = parseInt(el('inputNumeroTavoli').value, 10) || 4;
  const numeroRoundFase2 = parseInt(el('inputNumeroRound').value, 10) || 5;
  const numeroRoundFase4 = parseInt(el('inputNumeroRoundFase4').value, 10) || 3;
  const oreManagerialiPerRound = parseInt(el('inputOrePerRound').value, 10) || 10;
  const nomiTavoli = el('inputNomiTavoli').value.split('\n').map((s) => s.trim()).filter(Boolean);

  const res = await fetch('/api/sessioni', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nome, numeroTavoli, nomiTavoli, numeroRoundFase2, numeroRoundFase4, oreManagerialiPerRound })
  });
  if (!res.ok) {
    mostraToast('Errore nella creazione della sessione', 'errore');
    return;
  }
  const sessione = await res.json();
  salvaTokenLocale(sessione.id, sessione.tokenFacilitatore);
  scaricaCredenziali(sessione.id, sessione.tokenFacilitatore, sessione.nome);
  avviaSessione(sessione.id, sessione.tokenFacilitatore);
});

// Alla creazione, oltre a salvare il token in questo browser, scarica anche un piccolo file di
// backup: se il browser dovesse "dimenticare" il token (aggiornamento, pulizia dati, altro
// dispositivo), il facilitatore ha comunque una copia fuori dal browser.
function scaricaCredenziali(sessionId, token, nome) {
  const contenuto = `Less is More - credenziali sessione\nNome: ${nome}\nID sessione: ${sessionId}\nToken facilitatore: ${token}\n\nConserva questo file: serve per riaprire la regia se il browser richiede di nuovo il token.`;
  const blob = new Blob([contenuto], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `credenziali-${sessionId}.txt`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

el('btnResume').addEventListener('click', () => {
  const id = el('inputResumeId').value.trim();
  if (!id) return;
  const tokenInserito = el('inputResumeToken').value.trim();
  const token = tokenInserito || leggiTokenLocale(id);
  if (!token) {
    mostraToast('Serve il token facilitatore di questa sessione (ricevuto alla creazione) per riprenderla.', 'errore');
    return;
  }
  salvaTokenLocale(id, token);
  avviaSessione(id, token);
});

async function caricaListaSessioni() {
  try {
    const res = await fetch('/api/sessioni');
    const sessioni = await res.json();
    const box = el('listaSessioniEsistenti');
    box.innerHTML = '';
    sessioni.slice().reverse().forEach((s) => {
      const div = document.createElement('div');
      div.className = 'lista-sessioni-item';
      div.innerHTML = `<span>${s.nome} — ${s.numeroTavoli} tavoli — settimana ${s.roundCorrente}/${s.numeroRound} — <strong>${s.stato}</strong></span>`;
      const btn = document.createElement('button');
      btn.className = 'btn btn-secondario';
      btn.textContent = 'Apri';
      btn.style.padding = '4px 10px';
      btn.addEventListener('click', () => {
        let token = leggiTokenLocale(s.id);
        if (!token) {
          token = prompt(`Token facilitatore per "${s.nome}" (non salvato in questo browser):`);
          if (!token) return;
          salvaTokenLocale(s.id, token);
        }
        avviaSessione(s.id, token);
      });
      div.appendChild(btn);

      const btnElimina = document.createElement('button');
      btnElimina.className = 'btn btn-attenzione';
      btnElimina.textContent = 'Elimina';
      btnElimina.style.padding = '4px 10px';
      btnElimina.style.marginLeft = '6px';
      btnElimina.addEventListener('click', async () => {
        if (!confirm(`Eliminare definitivamente la sessione "${s.nome}"? L'operazione non e' reversibile.`)) return;
        let token = leggiTokenLocale(s.id);
        if (!token) {
          token = prompt(`Token facilitatore per "${s.nome}" (necessario per eliminarla):`);
          if (!token) return;
        }
        try {
          const r = await fetch(`/api/sessioni/${s.id}?tok=${encodeURIComponent(token)}`, { method: 'DELETE' });
          if (!r.ok) {
            mostraToast('Impossibile eliminare la sessione (token non valido?).', 'errore');
            return;
          }
          div.remove();
          mostraToast('Sessione eliminata.', 'successo');
        } catch (err) {
          mostraToast('Errore di rete durante l\'eliminazione.', 'errore');
        }
      });
      div.appendChild(btnElimina);

      box.appendChild(div);
    });
  } catch (err) { /* silenzioso: nessuna sessione precedente raggiungibile */ }
}
caricaListaSessioni();

// ---------- Avvio / ripresa sessione ----------

async function avviaSessione(sessionId, token) {
  state.sessionId = sessionId;
  state.token = token || leggiTokenLocale(sessionId);
  if (!state.token) {
    mostraToast('Serve il token facilitatore per aprire questa sessione.', 'errore');
    return;
  }

  const configRes = await fetch('/config/pubblico');
  const config = await configRes.json();
  state.eventiDisponibili = config.eventiFacilitatore;
  state.azioni = config.azioni;
  state.azioniSistemiche = config.azioniSistemiche;
  state.fasiConfig = config.fasi;
  state.azioneCoerentePerCluster = config.azioneCoerentePerCluster;
  popolaSelectEventi();

  state.socket = io();
  // Il "join" va rifatto ad OGNI evento connect, non solo alla prima connessione: se la rete
  // cade anche per un attimo (wifi instabile, laptop sospeso, tab in background), socket.io
  // riconnette da solo ma il server perde l'identita' legata al vecchio socket. Senza questo,
  // i pulsanti della regia smettono di rispondere in silenzio finche' non si ricarica la pagina.
  state.socket.on('connect', () => {
    state.socket.emit('facilitatore:join', { sessionId, tok: state.token });
  });
  state.socket.on('facilitatore:stato', (statoSessione) => {
    state.ultimoStato = statoSessione;
    if (state.terminazioneManualeInCorso) {
      // Dopo "Termina sessione" torniamo alla home invece di mostrare i risultati finali: i
      // risultati restano comunque calcolati e salvati, riapribili in seguito con "Riprendi".
      state.terminazioneManualeInCorso = false;
      state.socket.disconnect();
      el('statoSessioneBadge').classList.add('hidden');
      el('btnTerminaSessione').classList.add('hidden');
      el('btnMostraCredenziali').classList.add('hidden');
      el('boxCredenziali').classList.add('hidden');
      mostraSchermata('schermataCreazione');
      caricaListaSessioni();
      return;
    }
    renderStato(statoSessione);
  });
  state.socket.on('errore', (e) => mostraToast(e.messaggio, 'errore'));

  el('statoSessioneBadge').classList.remove('hidden');
  el('btnTerminaSessione').classList.remove('hidden');
  el('btnMostraCredenziali').classList.remove('hidden');
  el('credenzialeId').textContent = sessionId;
  el('credenzialeToken').textContent = state.token;

  await mostraLinkTavoli(sessionId);
}

// ---------- Termina sessione (sempre raggiungibile dalla barra in alto) ----------

el('btnTerminaSessione').addEventListener('click', () => {
  if (!state.sessionId) return;
  if (!confirm('Terminare definitivamente questa sessione adesso? Verranno calcolati i risultati finali con lo stato attuale (riapribili in seguito con "Riprendi"), e tornerai alla schermata iniziale.')) return;
  state.terminazioneManualeInCorso = true;
  state.socket.emit('facilitatore:terminaSessione', { sessionId: state.sessionId });
  mostraToast('Sessione terminata: risultati finali calcolati e salvati.', 'successo');
});

// ---------- Credenziali: recupero token/ID nello stesso browser, es. se il browser li richiede
// di nuovo dopo un aggiornamento (localStorage svuotato o cambio di browser/profilo). ----------

el('btnMostraCredenziali').addEventListener('click', () => {
  el('boxCredenziali').classList.toggle('hidden');
});

el('btnCopiaCredenziali').addEventListener('click', () => {
  const testo = `ID sessione: ${state.sessionId}\nToken facilitatore: ${state.token}`;
  navigator.clipboard.writeText(testo);
  mostraToast('Credenziali copiate negli appunti.', 'successo');
});

async function mostraLinkTavoli(sessionId) {
  const res = await fetch(`/api/sessioni/${sessionId}?tok=${encodeURIComponent(state.token)}`);
  if (!res.ok) {
    mostraToast('Token facilitatore non valido per questa sessione.', 'errore');
    return;
  }
  const sessione = await res.json();
  const griglia = el('grigliaLinkTavoli');
  griglia.innerHTML = '';

  for (const tavolo of sessione.tavoli) {
    const linkRes = await fetch(`/api/sessioni/${sessionId}/tavoli/${tavolo.id}/link?tok=${encodeURIComponent(state.token)}`);
    const { url, codiceAccesso, qrDataUrl } = await linkRes.json();

    const card = document.createElement('div');
    card.className = 'link-tavolo-card';
    card.innerHTML = `
      <h4>${tavolo.nome}</h4>
      <img src="${qrDataUrl}" alt="QR ${tavolo.nome}" />
      <div class="codice">${codiceAccesso}</div>
      <div class="url-box">${url}</div>
      <button class="btn btn-secondario btn-copia">Copia link</button>
    `;
    card.querySelector('.btn-copia').addEventListener('click', () => {
      navigator.clipboard.writeText(url);
      const b = card.querySelector('.btn-copia');
      b.textContent = 'Copiato!';
      setTimeout(() => (b.textContent = 'Copia link'), 1500);
    });
    griglia.appendChild(card);
  }

  mostraSchermata('schermataSalaAttesa');
}

el('btnVaiRegia').addEventListener('click', () => {
  if (state.ultimoStato) renderStato(state.ultimoStato);
  else mostraSchermata('schermataFase1');
});
el('btnMostraLink').addEventListener('click', () => mostraSchermata('schermataSalaAttesa'));
el('btnMostraLinkFase1').addEventListener('click', () => mostraSchermata('schermataSalaAttesa'));
el('btnTerminaFase1').addEventListener('click', () => {
  state.socket.emit('facilitatore:terminaFase1', { sessionId: state.sessionId });
});

// ---------- Controlli round ----------

el('btnAvviaRound').addEventListener('click', () => {
  state.socket.emit('facilitatore:avviaRound', { sessionId: state.sessionId });
});

el('btnChiudiRound').addEventListener('click', () => {
  if (!confirm('Chiudere la settimana corrente per tutti i tavoli?')) return;
  state.socket.emit('facilitatore:chiudiRound', { sessionId: state.sessionId });
});

el('btnMostraEventi').addEventListener('click', () => {
  el('pannelloEventi').classList.toggle('hidden');
});

// ---------- Timer di round ----------

el('btnRiavviaTimer').addEventListener('click', () => {
  state.socket.emit('facilitatore:riavviaTimer', { sessionId: state.sessionId });
});

// La durata e' modificabile sia prima di avviare una settimana (si applica alla prossima)
// sia a settimana gia' in corso: il countdown si aggiorna da solo perche' e' sempre ricalcolato
// da roundIniziatoIl + durataRoundSecondi, mai congelato al momento dell'avvio.
el('inputDurataRound').addEventListener('change', () => {
  const minuti = parseFloat(el('inputDurataRound').value);
  if (!minuti || minuti <= 0) return;
  state.socket.emit('facilitatore:impostaDurataRound', { sessionId: state.sessionId, minuti });
});

function sincronizzaDurataRound(sessione) {
  const input = el('inputDurataRound');
  if (document.activeElement === input) return; // non sovrascrivere mentre il facilitatore sta scrivendo
  if (sessione.durataRoundSecondi) {
    input.value = sessione.durataRoundSecondi / 60;
  }
}

function aggiornaTimer(sessione) {
  clearInterval(state.timerInterval);
  const box = el('timerRound');
  const durata = sessione.durataRoundSecondi;
  if (sessione.stato !== 'in_round' || !sessione.roundIniziatoIl || !durata) {
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');
  const tick = () => {
    const scadenza = sessione.roundIniziatoIl + durata * 1000;
    const residuoSec = Math.max(0, Math.round((scadenza - Date.now()) / 1000));
    const mm = String(Math.floor(residuoSec / 60)).padStart(2, '0');
    const ss = String(residuoSec % 60).padStart(2, '0');
    el('timerRoundValore').textContent = `${mm}:${ss}`;
    box.classList.toggle('scaduto', residuoSec === 0);
  };
  tick();
  if (!sessione.inPausa) {
    state.timerInterval = setInterval(tick, 1000);
  }
}

// ---------- Pausa/ripresa ----------

el('btnPausa').addEventListener('click', () => {
  if (state.ultimoStato && state.ultimoStato.inPausa) {
    state.socket.emit('facilitatore:riprendi', { sessionId: state.sessionId });
  } else {
    state.socket.emit('facilitatore:pausa', { sessionId: state.sessionId });
  }
});

// ---------- Backup / checkpoint ----------

el('btnMostraBackup').addEventListener('click', () => {
  el('pannelloBackup').classList.toggle('hidden');
  if (!el('pannelloBackup').classList.contains('hidden')) caricaListaBackup();
});

el('btnSalvaBackup').addEventListener('click', async () => {
  const res = await fetch(`/api/sessioni/${state.sessionId}/backup?tok=${encodeURIComponent(state.token)}`, { method: 'POST' });
  if (!res.ok) return mostraToast('Errore nel salvataggio del checkpoint.', 'errore');
  mostraToast('Checkpoint salvato.', 'successo');
  await caricaListaBackup();
});

async function caricaListaBackup() {
  const res = await fetch(`/api/sessioni/${state.sessionId}/backup?tok=${encodeURIComponent(state.token)}`);
  if (!res.ok) return;
  const { backups } = await res.json();
  const box = el('listaBackup');
  if (backups.length === 0) {
    box.innerHTML = '<p class="muted">Nessun checkpoint salvato finora.</p>';
    return;
  }
  box.innerHTML = '';
  backups.forEach((b) => {
    const div = document.createElement('div');
    div.className = 'lista-backup-item';
    const data = new Date(b.creatoIl).toLocaleTimeString('it-IT');
    div.innerHTML = `<span>${data} — settimana ${b.roundCorrente ?? '?'} (${b.stato ?? '?'})</span>`;
    const btn = document.createElement('button');
    btn.className = 'btn btn-attenzione';
    btn.textContent = 'Ripristina';
    btn.addEventListener('click', async () => {
      if (!confirm('Ripristinare questo checkpoint? Le scelte fatte dopo questo momento andranno perse per tutti i tavoli.')) return;
      const r = await fetch(`/api/sessioni/${state.sessionId}/restore?tok=${encodeURIComponent(state.token)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ backupId: b.backupId })
      });
      if (!r.ok) return mostraToast('Errore nel ripristino del checkpoint.', 'errore');
      mostraToast('Checkpoint ripristinato.', 'successo');
      el('pannelloBackup').classList.add('hidden');
    });
    div.appendChild(btn);
    box.appendChild(div);
  });
}

function popolaSelectEventi() {
  const sel = el('selectEvento');
  sel.innerHTML = '';
  state.eventiDisponibili.forEach((ev) => {
    const opt = document.createElement('option');
    opt.value = ev.id;
    opt.textContent = `${ev.titolo} — ${ev.testo.slice(0, 60)}...`;
    sel.appendChild(opt);
  });
}

el('btnInviaEvento').addEventListener('click', () => {
  const eventoId = el('selectEvento').value;
  const tavoloId = el('selectTavoloEvento').value || undefined;
  state.socket.emit('facilitatore:iniettaEvento', { sessionId: state.sessionId, eventoId, tavoloId });
  el('pannelloEventi').classList.add('hidden');
});

// ---------- Render ----------

function renderStato(sessione) {
  el('statoSessioneBadge').textContent = sessione.nome;
  sincronizzaDurataRound(sessione);

  if (sessione.stato === 'fase1_classificazione') {
    clearInterval(state.timerInterval);
    renderFase1(sessione);
    return;
  }

  if (sessione.stato === 'terminata' && sessione.risultatiFinali) {
    clearInterval(state.timerInterval);
    renderFinale(sessione);
    return;
  }

  el('roundCorrente').textContent = sessione.roundCorrente;
  el('roundTotale').textContent = sessione.numeroRound;

  const etichetteFase = { 2: 'Fase 2 — Scegliere', 3: 'Fase 3 — Crisi', 4: 'Fase 4 — Consolidare' };
  el('faseBadge').textContent = etichetteFase[sessione.faseCorrente] || `Fase ${sessione.faseCorrente}`;

  const inCrisi = sessione.faseCorrente === 3;
  el('bannerCrisi').classList.toggle('hidden', !inCrisi);
  if (inCrisi && state.fasiConfig) {
    el('testoCrisi').textContent = state.fasiConfig.crisi.testo;
  }

  const etichette = { lobby: 'In attesa di avvio', in_round: 'Settimana in corso', round_chiuso: 'Settimana chiusa — pronta per la prossima', terminata: 'Sessione terminata' };
  el('statoRoundLabel').textContent = etichette[sessione.stato] || sessione.stato;

  el('btnAvviaRound').classList.toggle('hidden', sessione.stato === 'in_round' || sessione.stato === 'terminata');
  el('btnAvviaRound').textContent = sessione.stato === 'round_chiuso' ? `Avvia Settimana ${sessione.roundCorrente}` : 'Avvia Settimana 1';
  el('btnChiudiRound').classList.toggle('hidden', sessione.stato !== 'in_round');

  el('btnPausa').classList.toggle('hidden', sessione.stato !== 'in_round' && !sessione.inPausa);
  el('btnPausa').textContent = sessione.inPausa ? 'Riprendi' : 'Pausa';
  el('bannerPausa').classList.toggle('hidden', !sessione.inPausa);
  aggiornaTimer(sessione);

  aggiornaSelectTavoloEvento(sessione.tavoli);
  renderTavoli(sessione.tavoli);
  renderClassificaLive(sessione.tavoli);
  renderGraficoRichieste(el('cardRichiesteManager'), sessione.tavoli);

  mostraSchermata('schermataRegia');
}

function renderFase1(sessione) {
  const griglia = el('grigliaFase1');
  griglia.innerHTML = '';
  sessione.tavoli.forEach((t) => {
    const classificati = t.collaboratori.filter((c) => c.categoriaAssegnata).length;
    const totale = t.collaboratori.length;
    const card = document.createElement('div');
    card.className = 'tavolo-card';
    card.innerHTML = `
      <div class="tavolo-card-header"><h4>${t.nome}</h4></div>
      <div class="progresso-classificazione">${classificati}/${totale} collaboratori con azione assegnata</div>
      <div class="progress-bar-track"><div class="progress-bar-fill" style="width:${totale > 0 ? Math.round((classificati / totale) * 100) : 0}%"></div></div>
      <div style="margin-top:10px;">
        ${t.collaboratori.map((c) => {
          const azioneCoerente = (state.azioneCoerentePerCluster || {})[c.cluster];
          const coerente = c.categoriaAssegnata && azioneCoerente && c.categoriaAssegnata === azioneCoerente;
          const incoerente = c.categoriaAssegnata && azioneCoerente && c.categoriaAssegnata !== azioneCoerente;
          return `
          <div class="collaboratore-riga">
            <span>${c.nome} <span class="stelle-riga-tavolo">${renderStelle(c.stelle)}</span> <span class="cluster-tag ${c.cluster}">${etichettaCluster(c.cluster)}</span>${c.categoriaAssegnata ? `<span class="categoria-tag${coerente ? ' categoria-coerente' : ''}${incoerente ? ' categoria-incoerente' : ''}">${c.categoriaAssegnata}</span>` : '<span class="categoria-tag categoria-vuota">— in attesa —</span>'}</span>
            <span>A:${c.stats.autonomia} M:${c.stats.motivazione} C:${c.stats.competenza}</span>
          </div>
        `;
        }).join('')}
      </div>
    `;
    griglia.appendChild(card);
  });
  mostraSchermata('schermataFase1');
}

function aggiornaSelectTavoloEvento(tavoli) {
  const sel = el('selectTavoloEvento');
  const valorePrecedente = sel.value;
  sel.innerHTML = '<option value="">Tutti i tavoli</option>';
  tavoli.forEach((t) => {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.nome;
    sel.appendChild(opt);
  });
  sel.value = valorePrecedente;
}

function renderTavoli(tavoli) {
  const griglia = el('grigliaTavoli');
  griglia.innerHTML = '';

  tavoli.forEach((t) => {
    const percentualeOre = t.oreDisponibiliRound > 0 ? Math.round((t.oreUsateRound / t.oreDisponibiliRound) * 100) : 0;
    const card = document.createElement('div');
    card.className = 'tavolo-card';
    card.innerHTML = `
      <div class="tavolo-card-header">
        <h4>${t.nome}</h4>
        <span class="tavolo-status-pill ${t.confermato ? 'confermato' : ''}">${t.confermato ? 'Pronto' : 'In lavorazione'}</span>
      </div>
      <div class="muted" style="font-size:0.75rem;margin-bottom:6px;">Ore usate: ${t.oreUsateRound}/${t.oreDisponibiliRound} · Clima: ${t.climaTeam}</div>
      <div class="progress-bar-track"><div class="progress-bar-fill ${percentualeOre > 90 ? 'warn' : ''}" style="width:${percentualeOre}%"></div></div>
      <div style="margin-top:10px;">
        ${t.collaboratori.map((c) => `
          <div class="collaboratore-riga">
            <span>${c.uscitoDallaRete ? '✕ ' : ''}${c.nome} <span class="stelle-riga-tavolo">${renderStelle(c.stelle)}</span> <span class="cluster-tag ${c.cluster}">${etichettaCluster(c.cluster)}</span>${c.categoriaAssegnata ? `<span class="categoria-tag">${c.categoriaAssegnata}</span>` : ''}${c.richiestaCorrente ? `<span class="categoria-tag" style="color:var(--gold-400)">chiede: ${c.richiestaCorrente.testo}</span>` : ''}</span>
            <span class="${c.rischioTurnover >= 50 ? 'rischio-alto' : ''}">A:${c.stats.autonomia} M:${c.stats.motivazione} C:${c.stats.competenza} ${c.rischioTurnover >= 50 ? '⚠' : ''}</span>
          </div>
        `).join('')}
      </div>
      ${(t.messaggiNarrativiRound || []).length > 0 ? `<div class="messaggio-narrativo-tag">${t.messaggiNarrativiRound.map((m) => m.testo).join(' · ')}</div>` : ''}
      ${t.impattoCrisi ? `<div class="impatto-crisi-tag">🔥 ${t.impattoCrisi.testo}</div>` : ''}
      <button class="btn-log-toggle">Log decisioni ▾</button>
      <div class="log-tavolo-inline hidden">
        <table>
          <thead><tr><th>Settimana</th><th>Collaboratore</th><th>Cluster</th><th>Azione</th><th>Ore</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
      ${t.confermato ? '<button class="btn-sblocca-tavolo">Sblocca scelte di questo tavolo</button>' : ''}
    `;

    const btnLog = card.querySelector('.btn-log-toggle');
    const boxLog = card.querySelector('.log-tavolo-inline');
    const corpoLog = card.querySelector('.log-tavolo-inline tbody');
    btnLog.addEventListener('click', () => {
      const stavaAperto = !boxLog.classList.contains('hidden');
      if (!stavaAperto) renderTabellaLog(corpoLog, t);
      boxLog.classList.toggle('hidden');
      btnLog.textContent = stavaAperto ? 'Log decisioni ▾' : 'Log decisioni ▴';
    });

    const btnSblocca = card.querySelector('.btn-sblocca-tavolo');
    if (btnSblocca) {
      btnSblocca.addEventListener('click', () => {
        state.socket.emit('facilitatore:sbloccaTavolo', { sessionId: state.sessionId, tavoloId: t.id });
      });
    }

    griglia.appendChild(card);
  });
}

// Stessa resa a stelline usata lato tavolo (vedi team.js), cosi' la regia mostra un colpo
// d'occhio coerente con quello che vedono i partecipanti, invece di soli numeri.
function renderStelle(n) {
  const piene = Math.max(0, Math.min(5, n || 0));
  return '★'.repeat(piene) + '☆'.repeat(5 - piene);
}

// ---------- Grafico andamento indicatori per tavolo (debrief finale) ----------
// Ordine di priorita' indicato: crescita, autonomia, motivazione, clima, efficienza gruppo,
// coerenza manageriale. Tutti e 6 in un unico grafico a linee compatto, un tavolo per card.
const SERIE_ANDAMENTO = [
  { chiave: 'crescita', label: 'Crescita', colore: '#4caf7d' },
  { chiave: 'autonomiaMedia', label: 'Autonomia', colore: '#d9b45c' },
  { chiave: 'motivazioneSquadra', label: 'Motivazione', colore: '#e8ca87' },
  { chiave: 'climaTeam', label: 'Clima', colore: '#5aa9e6' },
  { chiave: 'efficienzaGruppo', label: 'Efficienza gruppo', colore: '#d16fd1' },
  { chiave: 'coerenzaManageriale', label: 'Coerenza manageriale', colore: '#e06a5a' }
];

function renderGraficoAndamento(tavolo) {
  const storico = tavolo.storicoPunteggi || [];
  if (storico.length === 0) {
    return '<p class="muted" style="font-size:0.78rem;">Nessun dato di andamento disponibile: nessuna settimana ancora chiusa.</p>';
  }
  const W = 380, H = 150, PAD_L = 26, PAD_R = 8, PAD_T = 10, PAD_B = 18;
  const n = storico.length;
  const xFor = (i) => PAD_L + (n > 1 ? (i / (n - 1)) * (W - PAD_L - PAD_R) : (W - PAD_L - PAD_R) / 2);
  const yFor = (v) => H - PAD_B - (Math.max(0, Math.min(100, v || 0)) / 100) * (H - PAD_T - PAD_B);

  const griglia = [0, 50, 100].map((v) => `
    <line x1="${PAD_L}" y1="${yFor(v).toFixed(1)}" x2="${W - PAD_R}" y2="${yFor(v).toFixed(1)}" stroke="#1e2f50" stroke-width="1" />
    <text x="${PAD_L - 4}" y="${(yFor(v) + 3).toFixed(1)}" font-size="7" fill="#9aa7bd" text-anchor="end">${v}</text>
  `).join('');

  const linee = SERIE_ANDAMENTO.map((serie) => {
    const punti = storico.map((r, i) => `${xFor(i).toFixed(1)},${yFor(r[serie.chiave]).toFixed(1)}`).join(' ');
    return `<polyline points="${punti}" fill="none" stroke="${serie.colore}" stroke-width="2" />`;
  }).join('');

  const assiX = storico.map((r, i) => `<text x="${xFor(i).toFixed(1)}" y="${H - 4}" font-size="7" fill="#9aa7bd" text-anchor="middle">S${r.round}</text>`).join('');

  const legenda = SERIE_ANDAMENTO.map((serie) => `<span class="legenda-item"><span class="legenda-swatch" style="background:${serie.colore}"></span>${serie.label}</span>`).join('');

  return `
    <svg viewBox="0 0 ${W} ${H}" class="grafico-andamento-svg">${griglia}${linee}${assiX}</svg>
    <div class="legenda-andamento">${legenda}</div>
  `;
}

function etichettaCluster(cluster) {
  return { performer: 'Performer', potenziale: 'Potenziale', resistente: 'Resistente' }[cluster] || cluster;
}

function renderClassificaLive(tavoli) {
  const corpo = el('corpoClassificaLive');
  const righe = tavoli.map((t) => {
    const ultimo = t.storicoPunteggi[t.storicoPunteggi.length - 1] || { performanceRete: 0, autonomiaMedia: 0, climaTeam: 0 };
    return { nome: t.nome, ...ultimo };
  });
  righe.sort((a, b) => b.performanceRete - a.performanceRete);
  corpo.innerHTML = righe.map((r, i) => `
    <tr>
      <td>${i + 1}</td><td>${r.nome}</td><td>${r.performanceRete}</td>
      <td>—</td><td>${r.autonomiaMedia}</td><td>${r.climaTeam}</td>
    </tr>
  `).join('');
}

function renderFinale(sessione) {
  mostraSchermata('schermataFinale');
  const corpo = el('corpoClassificaFinale');
  corpo.innerHTML = sessione.risultatiFinali.classifica.map((r) => `
    <tr>
      <td>${r.posizione}</td><td>${r.nome}</td><td>${r.performanceRete}</td>
      <td>${r.crescitaCollaboratori}</td><td>${r.efficienzaTempo}</td>
      <td>${r.autonomiaSquadra}</td><td>${r.motivazioneSquadra}</td><td>${r.clima}</td>
      <td>${r.sostenibilita}</td><td>${r.coerenzaManageriale}</td>
      <td><strong>${r.punteggioTotale}</strong></td>
    </tr>
  `).join('');

  const griglia = el('grigliaProfiliFinali');
  griglia.innerHTML = '';
  for (const tavolo of sessione.tavoli) {
    const profilo = sessione.risultatiFinali.profili[tavolo.id];
    if (!profilo) continue;
    const card = document.createElement('div');
    card.className = 'profilo-card';
    card.innerHTML = `
      <div class="tavolo-nome">${tavolo.nome}</div>
      <h4>${profilo.profiloPrincipale.label}</h4>
      <p class="muted">${profilo.profiloPrincipale.descrizione}</p>
      <div class="tendenza">Tendenza secondaria: ${profilo.tendenzaSecondaria.label}</div>
    `;
    griglia.appendChild(card);
  }

  const grigliaEpiloghi = el('grigliaEpiloghiFinali');
  if (grigliaEpiloghi) {
    grigliaEpiloghi.innerHTML = '';
    const epiloghi = sessione.risultatiFinali.epiloghi || {};
    for (const tavolo of sessione.tavoli) {
      const epilogo = epiloghi[tavolo.id];
      if (!epilogo) continue;
      const card = document.createElement('div');
      card.className = 'profilo-card';
      card.innerHTML = `
        <div class="tavolo-nome">${tavolo.nome}</div>
        <h4>${epilogo.titolo}</h4>
        <p class="muted">${epilogo.testo}</p>
      `;
      grigliaEpiloghi.appendChild(card);
    }
  }

  renderGraficoRichieste(el('grigliaGraficiRichiesteFinale'), sessione.tavoli);

  const grigliaAndamento = el('grigliaAndamentoTavoli');
  if (grigliaAndamento) {
    grigliaAndamento.innerHTML = '';
    for (const tavolo of sessione.tavoli) {
      const card = document.createElement('div');
      card.className = 'profilo-card';
      card.innerHTML = `<div class="tavolo-nome">${tavolo.nome}</div>${renderGraficoAndamento(tavolo)}`;
      grigliaAndamento.appendChild(card);
    }
  }

  popolaSelectTavoloLog(sessione.tavoli);
  mostraSchermata('schermataFinale');
}

function popolaSelectTavoloLog(tavoli) {
  const sel = el('selectTavoloLog');
  const valorePrecedente = sel.value;
  sel.innerHTML = '';
  tavoli.forEach((t) => {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.nome;
    sel.appendChild(opt);
  });
  sel.value = tavoli.some((t) => t.id === valorePrecedente) ? valorePrecedente : (tavoli[0] && tavoli[0].id);

  const tavoloSelezionato = tavoli.find((t) => t.id === sel.value);
  if (tavoloSelezionato) renderTabellaLog(el('corpoLogDecisioni'), tavoloSelezionato);

  sel.onchange = () => {
    const t = tavoli.find((tv) => tv.id === sel.value);
    if (t) renderTabellaLog(el('corpoLogDecisioni'), t);
  };
}
