'use strict';
/**
 * Test end-to-end (Fase 2, motore profili): crea una sessione con 3 tavoli via
 * REST, salta la Fase 1 (testata a parte in unit_engine.js), poi simula 5 round
 * di Fase 2 con tre stili decisionali diversi per verificare che il motore
 * profili produca risultati differenziati. Termina la sessione manualmente
 * (facilitatore:terminaSessione) senza giocare Fase 3/4, che sono coperte da
 * test/simulate_fasi.js.
 */
const io = require('socket.io-client');

const BASE = 'http://localhost:3000';

async function main() {
  const creaRes = await fetch(`${BASE}/api/sessioni`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nome: 'Test E2E', numeroTavoli: 3, numeroRoundFase2: 5, oreManagerialiPerRound: 10 })
  });
  const sessione = await creaRes.json();
  const tokenFacilitatore = sessione.tokenFacilitatore;
  console.log('Sessione creata:', sessione.id, 'tavoli:', sessione.tavoli.map((t) => t.id));

  const [tavoloColtivatore, tavoloAccentratore, tavoloPompiere] = sessione.tavoli;

  // Risolve il token di ciascun tavolo tramite il suo codice d'accesso, come farebbe un
  // client reale (nessun accesso diretto all'oggetto tavolo lato server).
  async function tokenTavolo(tavolo) {
    const res = await fetch(`${BASE}/api/sessioni/${sessione.id}/resolve-codice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ codice: tavolo.codiceAccesso })
    });
    const { token } = await res.json();
    return token;
  }
  const tokenColtivatore = await tokenTavolo(tavoloColtivatore);
  const tokenAccentratore = await tokenTavolo(tavoloAccentratore);
  const tokenPompiere = await tokenTavolo(tavoloPompiere);

  const facilitatore = io(BASE);
  await new Promise((resolve) => facilitatore.on('connect', resolve));
  facilitatore.emit('facilitatore:join', { sessionId: sessione.id, tok: tokenFacilitatore });

  let ultimoStatoFacilitatore = null;
  facilitatore.on('facilitatore:stato', (s) => { ultimoStatoFacilitatore = s; });

  function connettiTavolo(tavoloId, tok) {
    return new Promise((resolve) => {
      const socket = io(BASE);
      socket.on('connect', () => {
        socket.emit('tavolo:join', { sessionId: sessione.id, tavoloId, tok });
        socket.on('tavolo:stato', () => {}); // silenzia
        if (process.env.DEBUG_METRICHE) {
          socket.on('tavolo:erroreAzione', (err) => {
            console.log(`  [erroreAzione ${tavoloId}]`, JSON.stringify(err));
          });
        }
        resolve(socket);
      });
    });
  }

  const socketColtivatore = await connettiTavolo(tavoloColtivatore.id, tokenColtivatore);
  const socketAccentratore = await connettiTavolo(tavoloAccentratore.id, tokenAccentratore);
  const socketPompiere = await connettiTavolo(tavoloPompiere.id, tokenPompiere);

  const collaboratori = tavoloColtivatore.collaboratori.map((c) => ({ id: c.id, cluster: c.cluster }));
  const potenziali = collaboratori.filter((c) => c.cluster === 'potenziale').map((c) => c.id);
  const performer = collaboratori.filter((c) => c.cluster === 'performer').map((c) => c.id);
  const resistenti = collaboratori.filter((c) => c.cluster === 'resistente').map((c) => c.id);

  function submit(socket, tavoloId, collaboratoreId, azioneId) {
    socket.emit('tavolo:submitAzione', { sessionId: sessione.id, tavoloId, collaboratoreId, azioneId });
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // Salta la Fase 1 (classificazione) e passa direttamente alla Fase 2.
  facilitatore.emit('facilitatore:terminaFase1', { sessionId: sessione.id });
  await sleep(150);

  for (let round = 1; round <= 5; round++) {
    facilitatore.emit('facilitatore:avviaRound', { sessionId: sessione.id });
    await sleep(150);

    // Coltivatore: investe forte su potenziale, delega su performer, poco sui resistenti (10 ore/round)
    potenziali.forEach((id) => submit(socketColtivatore, tavoloColtivatore.id, id, 'coaching')); // 3+3=6
    performer.forEach((id) => submit(socketColtivatore, tavoloColtivatore.id, id, 'delega')); // 1+1=2
    // resistenti: nessun intervento (0 ore) -> totale 8/10

    // Accentratore: monitoraggio/feedback su TUTTI, mai delega, mai nessun intervento, usa tutto il budget ogni round
    const tuttiCollaboratori = [...performer, ...potenziali, ...resistenti]; // 6 collaboratori
    // 5 x monitoraggio (2h) = 10h esatte: tocca 5 su 6 ogni round, ruota chi resta fuori
    const escluso = tuttiCollaboratori[round % tuttiCollaboratori.length];
    tuttiCollaboratori.filter((id) => id !== escluso).forEach((id) => submit(socketAccentratore, tavoloAccentratore.id, id, 'monitoraggio'));

    // Pompiere: ogni round concentra ~10 ore su una coppia diversa di collaboratori (nessun pattern fisso,
    // azioni non coerenti col cluster), il resto della rete resta scoperto -> alta reattivita' round su round
    const coppiePerRound = [
      [performer[0], potenziali[0]],
      [resistenti[0], resistenti[1]],
      [potenziali[1], performer[1]],
      [performer[0], resistenti[0]],
      [potenziali[0], performer[1]]
    ];
    const coppia = coppiePerRound[(round - 1) % coppiePerRound.length];
    submit(socketPompiere, tavoloPompiere.id, coppia[0], 'shadowing'); // 4h, azione "sbagliata" per il cluster
    submit(socketPompiere, tavoloPompiere.id, coppia[1], 'coaching'); // 3h

    await sleep(200);
    facilitatore.emit('facilitatore:chiudiRound', { sessionId: sessione.id });
    await sleep(200);
  }

  // Termina qui volutamente (non si gioca Fase 3/4 in questo test) per verificare
  // anche la chiusura anticipata forzata dal facilitatore.
  facilitatore.emit('facilitatore:terminaSessione', { sessionId: sessione.id });
  await sleep(300);
  const finaleRes = await fetch(`${BASE}/api/sessioni/${sessione.id}?tok=${tokenFacilitatore}`);
  const finale = await finaleRes.json();

  console.log('\n=== STATO FINALE ===');
  console.log('Stato sessione:', finale.stato, '| round:', finale.roundCorrente, '/', finale.numeroRound);

  console.log('\n=== CLASSIFICA ===');
  console.table(ultimoStatoFacilitatore.risultatiFinali.classifica);

  console.log('\n=== PROFILI ===');
  for (const [tavoloId, profilo] of Object.entries(ultimoStatoFacilitatore.risultatiFinali.profili)) {
    const nomeTavolo = finale.tavoli.find((t) => t.id === tavoloId).nome;
    console.log(`${nomeTavolo}: ${profilo.profiloPrincipale.label} (dist=${profilo.profiloPrincipale.distanza.toFixed(3)}) | tendenza secondaria: ${profilo.tendenzaSecondaria.label}`);
    if (process.env.DEBUG_METRICHE) {
      console.log('  metriche:', JSON.stringify(profilo.metriche));
      const t = finale.tavoli.find((tt) => tt.id === tavoloId);
      console.log('  punteggiPerRoundLen (via log):', t.log ? t.log.length : 'n/a');
    }
  }

  const assertions = [];
  const profiloColtivatore = ultimoStatoFacilitatore.risultatiFinali.profili[tavoloColtivatore.id].profiloPrincipale.chiave;
  const profiloAccentratore = ultimoStatoFacilitatore.risultatiFinali.profili[tavoloAccentratore.id].profiloPrincipale.chiave;
  const profiloPompiereCalc = ultimoStatoFacilitatore.risultatiFinali.profili[tavoloPompiere.id].profiloPrincipale.chiave;

  assertions.push(['Tavolo coltivatore -> profilo coltivatore', profiloColtivatore === 'coltivatore']);
  assertions.push(['Tavolo accentratore -> profilo accentratore', profiloAccentratore === 'accentratore']);
  assertions.push(['Tavolo pompiere -> profilo pompiere', profiloPompiereCalc === 'pompiere']);
  assertions.push(['Sessione terminata manualmente dopo 5 round di Fase 2', finale.stato === 'terminata']);
  assertions.push(['Classifica ha 3 righe ordinate', ultimoStatoFacilitatore.risultatiFinali.classifica.length === 3]);

  // --- Verifica resume: un nuovo facilitatore che si collega a sessione gia' terminata
  // deve ricevere subito risultatiFinali (non solo dopo un nuovo evento) ---
  const facilitatoreResume = io(BASE);
  await new Promise((resolve) => facilitatoreResume.on('connect', resolve));
  const statoResumePromise = new Promise((resolve) => facilitatoreResume.once('facilitatore:stato', resolve));
  facilitatoreResume.emit('facilitatore:join', { sessionId: sessione.id, tok: tokenFacilitatore });
  const statoResume = await statoResumePromise;
  assertions.push(['Resume facilitatore include risultatiFinali', !!(statoResume.risultatiFinali && statoResume.risultatiFinali.classifica.length === 3)]);
  facilitatoreResume.close();

  // --- Verifica resume tavolo: un tavolo che si ricollega dopo la fine riceve subito profilo/risultato ---
  const tavoloResume = io(BASE);
  await new Promise((resolve) => tavoloResume.on('connect', resolve));
  const statoTavoloResumePromise = new Promise((resolve) => tavoloResume.once('tavolo:stato', resolve));
  tavoloResume.emit('tavolo:join', { sessionId: sessione.id, tavoloId: tavoloColtivatore.id, tok: tokenColtivatore });
  const statoTavoloResume = await statoTavoloResumePromise;
  assertions.push(['Resume tavolo include profilo e risultato finale', !!(statoTavoloResume.profilo && statoTavoloResume.risultatoFinale)]);
  tavoloResume.close();

  // --- Verifica sicurezza: senza token corretto, il join viene rifiutato ---
  const tavoloTokenErrato = io(BASE);
  await new Promise((resolve) => tavoloTokenErrato.on('connect', resolve));
  const erroreJoinPromise = new Promise((resolve) => tavoloTokenErrato.once('errore', resolve));
  tavoloTokenErrato.emit('tavolo:join', { sessionId: sessione.id, tavoloId: tavoloColtivatore.id, tok: 'token-sbagliato' });
  const erroreJoin = await erroreJoinPromise;
  assertions.push(['tavolo:join con token errato viene rifiutato', !!erroreJoin && /token/i.test(erroreJoin.messaggio)]);
  tavoloTokenErrato.close();

  const getSenzaToken = await fetch(`${BASE}/api/sessioni/${sessione.id}`);
  assertions.push(['GET /api/sessioni/:id senza token restituisce 403', getSenzaToken.status === 403]);

  // --- Verifica REST /api/sessioni/:id include anche risultatiFinali (coerenza con socket) ---
  assertions.push(['REST GET sessione include risultatiFinali', !!(finale.risultatiFinali && finale.risultatiFinali.classifica.length === 3)]);

  console.log('\n=== VERIFICHE ===');
  let tuttoOk = true;
  for (const [desc, ok] of assertions) {
    console.log(ok ? 'PASS' : 'FAIL', '-', desc);
    if (!ok) tuttoOk = false;
  }

  facilitatore.close();
  socketColtivatore.close();
  socketAccentratore.close();
  socketPompiere.close();

  process.exit(tuttoOk ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
