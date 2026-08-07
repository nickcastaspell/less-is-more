'use strict';
/**
 * Test end-to-end del sistema a 4 fasi attraverso l'intera pila (REST + Socket.io,
 * come farebbero davvero regia e tavolo). Copre: classificazione Fase 1, richieste
 * in Fase 2, riduzione ore in Fase 3 (crisi), azioni sistemiche in Fase 4, e la
 * corretta propagazione di tutti questi dati nelle viste inviate a tavolo/regia.
 */
const io = require('socket.io-client');

const BASE = 'http://localhost:3000';
const risultati = [];
function verifica(desc, condizione) {
  risultati.push([desc, !!condizione]);
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const creaRes = await fetch(`${BASE}/api/sessioni`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nome: 'Test Fasi', numeroTavoli: 1, numeroRoundFase2: 5, numeroRoundFase4: 3, oreManagerialiPerRound: 10 })
  });
  const sessione = await creaRes.json();
  const tokenFacilitatore = sessione.tokenFacilitatore;
  const tavolo = sessione.tavoli[0];
  verifica('sessione creata con numeroRound = 5+1+3 = 9', sessione.numeroRound === 9);
  verifica('sessione parte in fase1_classificazione', sessione.stato === 'fase1_classificazione');
  verifica('faseCorrente iniziale = 1', sessione.faseCorrente === 1);

  const codiceRes = await fetch(`${BASE}/api/sessioni/${sessione.id}/resolve-codice`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ codice: tavolo.codiceAccesso })
  });
  const { token: tokenTavolo } = await codiceRes.json();

  const facilitatore = io(BASE);
  await new Promise((resolve) => facilitatore.on('connect', resolve));
  let statoFacilitatore = null;
  facilitatore.on('facilitatore:stato', (s) => { statoFacilitatore = s; });
  facilitatore.emit('facilitatore:join', { sessionId: sessione.id, tok: tokenFacilitatore });
  await sleep(150);

  const socketTavolo = io(BASE);
  await new Promise((resolve) => socketTavolo.on('connect', resolve));
  let statoTavolo = null;
  socketTavolo.on('tavolo:stato', (s) => { statoTavolo = s; });
  socketTavolo.emit('tavolo:join', { sessionId: sessione.id, tavoloId: tavolo.id, tok: tokenTavolo });
  await sleep(150);

  // ---------- Fase 1: classificazione ----------
  // 6 emit ravvicinati, ognuno dei quali fa un salvataggio su disco lato server: in ambienti
  // piu' lenti serve un margine superiore ai 200ms usati altrove per lasciare che tutti i
  // round-trip (emit -> salvaSuDisco -> broadcast) si completino prima di leggere lo stato.
  for (const c of tavolo.collaboratori) {
    socketTavolo.emit('tavolo:classificaCollaboratore', { sessionId: sessione.id, tavoloId: tavolo.id, collaboratoreId: c.id, categoria: 'Investirei' });
  }
  await sleep(500);
  verifica('categoria assegnata visibile lato tavolo dopo la classificazione', statoTavolo.collaboratori.every((c) => c.categoriaAssegnata === 'Investirei'));
  verifica('categoria assegnata visibile anche lato facilitatore', statoFacilitatore.tavoli[0].collaboratori.every((c) => c.categoriaAssegnata === 'Investirei'));

  facilitatore.emit('facilitatore:terminaFase1', { sessionId: sessione.id });
  await sleep(150);
  verifica('dopo terminaFase1 lo stato passa a lobby', statoFacilitatore.stato === 'lobby');

  function submit(collaboratoreId, azioneId) {
    socketTavolo.emit('tavolo:submitAzione', { sessionId: sessione.id, tavoloId: tavolo.id, collaboratoreId, azioneId });
  }

  const idCollaboratori = tavolo.collaboratori.map((c) => c.id);

  // ---------- Fase 2: 5 round, uso di visita proattiva su chi non ha richiesta ----------
  for (let round = 1; round <= 5; round++) {
    facilitatore.emit('facilitatore:avviaRound', { sessionId: sessione.id });
    await sleep(150);

    if (round === 1) {
      verifica('in Fase 2 round 1, faseCorrente = 2', statoFacilitatore.faseCorrente === 2);
      verifica('ore disponibili piene in Fase 2 (nessuna crisi)', statoFacilitatore.tavoli[0].oreDisponibiliRound === 10);
    }

    // Spendi su chi ha una richiesta attiva, "visita proattiva" su un paio di altri
    let oreSpese = 0;
    for (const id of idCollaboratori) {
      if (oreSpese >= 8) break;
      const collab = statoTavolo.collaboratori.find((c) => c.id === id);
      const azione = collab && collab.richiestaCorrente ? 'feedback' : 'visitaProattiva';
      submit(id, azione);
      oreSpese += azione === 'feedback' ? 2 : 2;
    }
    await sleep(150);
    facilitatore.emit('facilitatore:chiudiRound', { sessionId: sessione.id });
    await sleep(200);
  }

  verifica('storicoRichieste ha 5 voci dopo 5 round di Fase 2', statoFacilitatore.tavoli[0].storicoRichieste.length === 5);

  // ---------- Fase 3: round di crisi (round 6) ----------
  facilitatore.emit('facilitatore:avviaRound', { sessionId: sessione.id });
  await sleep(150);
  verifica('in Fase 3 (round 6), faseCorrente = 3', statoFacilitatore.faseCorrente === 3);
  verifica('ore ridotte in crisi (10 * 0.7 = 7)', statoFacilitatore.tavoli[0].oreDisponibiliRound === 7);
  const richiesteCrisi = statoFacilitatore.tavoli[0].storicoRichieste[5];
  verifica('richieste generate anche nel round di crisi', richiesteCrisi && richiesteCrisi.round === 6);

  idCollaboratori.slice(0, 3).forEach((id) => submit(id, 'monitoraggio'));
  await sleep(150);
  facilitatore.emit('facilitatore:chiudiRound', { sessionId: sessione.id });
  await sleep(200);

  // ---------- Fase 4: 3 round, uso di azioni sistemiche ----------
  facilitatore.emit('facilitatore:avviaRound', { sessionId: sessione.id });
  await sleep(150);
  verifica('in Fase 4 (round 7), faseCorrente = 4', statoFacilitatore.faseCorrente === 4);
  verifica('ore tornate piene dopo la crisi', statoFacilitatore.tavoli[0].oreDisponibiliRound === 10);

  socketTavolo.emit('tavolo:submitAzioneSistemica', { sessionId: sessione.id, tavoloId: tavolo.id, azioneSistemicaId: 'buddy' });
  await sleep(150);
  verifica('azione sistemica visibile nello stato tavolo', statoTavolo.azioniSistemicheSottomesseRound.includes('buddy'));

  facilitatore.emit('facilitatore:chiudiRound', { sessionId: sessione.id });
  await sleep(200);
  verifica('azione sistemica registrata nel log del facilitatore', statoFacilitatore.tavoli[0].azioniSistemicheLog.some((l) => l.azioneSistemicaId === 'buddy'));

  for (let round = 8; round <= 9; round++) {
    facilitatore.emit('facilitatore:avviaRound', { sessionId: sessione.id });
    await sleep(150);
    idCollaboratori.slice(0, 2).forEach((id) => submit(id, 'coaching'));
    await sleep(150);
    facilitatore.emit('facilitatore:chiudiRound', { sessionId: sessione.id });
    await sleep(200);
  }

  verifica('sessione terminata naturalmente dopo 9 round', statoFacilitatore.stato === 'terminata');
  verifica('risultati finali presenti (classifica + profili)', !!(statoFacilitatore.risultatiFinali && statoFacilitatore.risultatiFinali.classifica.length === 1));
  verifica('storicoRichieste copre tutti e 9 i round giocati', statoFacilitatore.tavoli[0].storicoRichieste.length === 9);

  console.log('=== TEST INTEGRAZIONE 4 FASI ===');
  let tuttoOk = true;
  for (const [desc, ok] of risultati) {
    console.log(ok ? 'PASS' : 'FAIL', '-', desc);
    if (!ok) tuttoOk = false;
  }

  facilitatore.close();
  socketTavolo.close();
  process.exit(tuttoOk ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
