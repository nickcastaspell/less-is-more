'use strict';
/**
 * Test di sicurezza: verifica che un socket unito come tavolo A non possa agire
 * su tavolo B (o su una sessione diversa) semplicemente inviando un tavoloId/
 * sessionId diverso nel payload dell'evento. Il server deve usare solo
 * l'identita' stabilita al join (socket.data), ignorando questi campi quando
 * presenti su eventi successivi al join.
 */
const io = require('socket.io-client');

const BASE = 'http://localhost:3000';

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const creaRes = await fetch(`${BASE}/api/sessioni`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nome: 'Test Sicurezza', numeroTavoli: 2, numeroRoundFase2: 5, oreManagerialiPerRound: 10 })
  });
  const sessione = await creaRes.json();
  const tokenFacilitatore = sessione.tokenFacilitatore;
  const [tavoloA, tavoloB] = sessione.tavoli;

  async function tokenTavolo(tavolo) {
    const res = await fetch(`${BASE}/api/sessioni/${sessione.id}/resolve-codice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ codice: tavolo.codiceAccesso })
    });
    return (await res.json()).token;
  }
  const tokenA = await tokenTavolo(tavoloA);

  const facilitatore = io(BASE);
  await new Promise((resolve) => facilitatore.on('connect', resolve));
  let statoFacilitatore = null;
  facilitatore.on('facilitatore:stato', (s) => { statoFacilitatore = s; });
  facilitatore.emit('facilitatore:join', { sessionId: sessione.id, tok: tokenFacilitatore });
  await sleep(150);

  facilitatore.emit('facilitatore:terminaFase1', { sessionId: sessione.id });
  await sleep(150);
  facilitatore.emit('facilitatore:avviaRound', { sessionId: sessione.id });
  await sleep(150);

  const socketA = io(BASE);
  await new Promise((resolve) => socketA.on('connect', resolve));
  let statoA = null;
  socketA.on('tavolo:stato', (s) => { statoA = s; });
  socketA.emit('tavolo:join', { sessionId: sessione.id, tavoloId: tavoloA.id, tok: tokenA });
  await sleep(150);

  const collabTarget = tavoloB.collaboratori[0].id;

  // socketA e' legittimamente unito al tavolo A. Prova a colpire il tavolo B
  // inviando un tavoloId (e sessionId) diverso nel payload dell'evento.
  socketA.emit('tavolo:submitAzione', {
    sessionId: sessione.id,
    tavoloId: tavoloB.id, // spoofing tentato
    collaboratoreId: collabTarget,
    azioneId: 'coaching'
  });
  await sleep(200);

  const statoFinaleRes = await fetch(`${BASE}/api/sessioni/${sessione.id}?tok=${tokenFacilitatore}`);
  const statoFinale = await statoFinaleRes.json();
  const tavoloBAggiornato = statoFinale.tavoli.find((t) => t.id === tavoloB.id);
  const tavoloAAggiornato = statoFinale.tavoli.find((t) => t.id === tavoloA.id);

  const risultati = [];
  function verifica(desc, condizione) { risultati.push([desc, !!condizione]); }

  verifica(
    'spoofing tavoloId ignorato: tavolo B non ha ricevuto ore su collaboratore target',
    tavoloBAggiornato.oreUsateRound === 0
  );
  verifica(
    'l\'azione e\' stata applicata invece al VERO tavolo del socket (tavolo A)',
    tavoloAAggiornato.oreUsateRound > 0
  );

  // Anche il collaboratore target (di B) non deve mostrare l'azione ricevuta.
  const collabBTarget = tavoloBAggiornato.collaboratori.find((c) => c.id === collabTarget);
  verifica(
    'il collaboratore di tavolo B preso di mira non ha ricevuto alcuna richiesta/azione fittizia',
    !collabBTarget.uscitoDallaRete
  );

  // Tentativo di spoofing lato facilitatore: un socket NON unito come facilitatore
  // (es. socketA, unito solo come tavolo) non deve poter chiudere il round.
  socketA.emit('facilitatore:chiudiRound', { sessionId: sessione.id });
  await sleep(200);
  const statoDopoTentativo = await (await fetch(`${BASE}/api/sessioni/${sessione.id}?tok=${tokenFacilitatore}`)).json();
  verifica(
    'un socket "tavolo" non puo\' invocare facilitatore:chiudiRound (stato ancora in_round)',
    statoDopoTentativo.stato === 'in_round'
  );

  console.log('=== TEST SICUREZZA SOCKET.DATA ===');
  let tuttoOk = true;
  for (const [desc, ok] of risultati) {
    console.log(ok ? 'PASS' : 'FAIL', '-', desc);
    if (!ok) tuttoOk = false;
  }

  facilitatore.close();
  socketA.close();
  process.exit(tuttoOk ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
