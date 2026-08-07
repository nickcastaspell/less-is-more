'use strict';
/**
 * Test end-to-end degli strumenti operativi per il facilitatore: timer di round,
 * lock delle scelte dopo la conferma (con sblocco tavolo/facilitatore), pausa/ripresa
 * della sessione, backup/restore manuale. Copre l'intera pila (REST + Socket.io).
 */
const io = require('socket.io-client');

const BASE = 'http://localhost:3000';
const risultati = [];
function verifica(desc, condizione) { risultati.push([desc, !!condizione]); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const creaRes = await fetch(`${BASE}/api/sessioni`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nome: 'Test Strumenti', numeroTavoli: 1, numeroRoundFase2: 5, oreManagerialiPerRound: 10 })
  });
  const sessione = await creaRes.json();
  const tokenFacilitatore = sessione.tokenFacilitatore;
  const tavolo = sessione.tavoli[0];

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
  let ultimoErroreAzione = null;
  socketTavolo.on('tavolo:stato', (s) => { statoTavolo = s; });
  socketTavolo.on('tavolo:erroreAzione', (e) => { ultimoErroreAzione = e; });
  socketTavolo.emit('tavolo:join', { sessionId: sessione.id, tavoloId: tavolo.id, tok: tokenTavolo });
  await sleep(150);

  facilitatore.emit('facilitatore:terminaFase1', { sessionId: sessione.id });
  await sleep(150);

  const collaboratoreId = tavolo.collaboratori[0].id;

  // ---------- Timer ----------
  facilitatore.emit('facilitatore:avviaRound', { sessionId: sessione.id });
  await sleep(200);
  verifica('roundIniziatoIl impostato dopo avviaRound', typeof statoFacilitatore.roundIniziatoIl === 'number');
  verifica('durataRoundSecondi visibile lato tavolo', statoTavolo.durataRoundSecondi === sessione.gameConfig.durataRoundSecondi);

  const timerPrimaDiRiavvio = statoFacilitatore.roundIniziatoIl;
  await sleep(50);
  facilitatore.emit('facilitatore:riavviaTimer', { sessionId: sessione.id });
  await sleep(150);
  verifica('facilitatore:riavviaTimer sposta in avanti roundIniziatoIl', statoFacilitatore.roundIniziatoIl > timerPrimaDiRiavvio);

  // ---------- Lock dopo conferma ----------
  socketTavolo.emit('tavolo:submitAzione', { sessionId: sessione.id, tavoloId: tavolo.id, collaboratoreId, azioneId: 'coaching' });
  await sleep(150);
  verifica('azione registrata prima della conferma', statoTavolo.azioniSottomesseRound[collaboratoreId] === 'coaching');

  socketTavolo.emit('tavolo:confermaRound', { sessionId: sessione.id, tavoloId: tavolo.id });
  await sleep(150);
  verifica('tavolo risulta confermato', statoTavolo.confermato === true);

  ultimoErroreAzione = null;
  socketTavolo.emit('tavolo:submitAzione', { sessionId: sessione.id, tavoloId: tavolo.id, collaboratoreId, azioneId: 'feedback' });
  await sleep(150);
  verifica('submitAzione bloccato server-side dopo conferma (lock reale, non solo cosmetico)', statoTavolo.azioniSottomesseRound[collaboratoreId] === 'coaching');
  verifica('errore di lock ricevuto dal tavolo', !!ultimoErroreAzione && /bloccate/i.test(ultimoErroreAzione.messaggio));

  socketTavolo.emit('tavolo:sbloccaConferma', { sessionId: sessione.id, tavoloId: tavolo.id });
  await sleep(150);
  verifica('tavolo puo\' sbloccarsi da solo', statoTavolo.confermato === false);

  socketTavolo.emit('tavolo:submitAzione', { sessionId: sessione.id, tavoloId: tavolo.id, collaboratoreId, azioneId: 'feedback' });
  await sleep(150);
  verifica('dopo lo sblocco, submitAzione torna a funzionare', statoTavolo.azioniSottomesseRound[collaboratoreId] === 'feedback');

  // Lock + sblocco lato facilitatore
  socketTavolo.emit('tavolo:confermaRound', { sessionId: sessione.id, tavoloId: tavolo.id });
  await sleep(150);
  facilitatore.emit('facilitatore:sbloccaTavolo', { sessionId: sessione.id, tavoloId: tavolo.id });
  await sleep(150);
  verifica('il facilitatore puo\' sbloccare un tavolo da regia', statoTavolo.confermato === false);

  // ---------- Pausa/ripresa ----------
  const timerPrimaDellaPausa = statoFacilitatore.roundIniziatoIl;
  facilitatore.emit('facilitatore:pausa', { sessionId: sessione.id });
  await sleep(150);
  verifica('sessione in pausa dopo facilitatore:pausa', statoFacilitatore.inPausa === true && statoTavolo.inPausa === true);

  ultimoErroreAzione = null;
  socketTavolo.emit('tavolo:submitAzione', { sessionId: sessione.id, tavoloId: tavolo.id, collaboratoreId, azioneId: 'delega' });
  await sleep(150);
  verifica('azioni del tavolo bloccate durante la pausa', statoTavolo.azioniSottomesseRound[collaboratoreId] === 'feedback');
  verifica('errore di pausa ricevuto dal tavolo', !!ultimoErroreAzione && /pausa/i.test(ultimoErroreAzione.messaggio));

  await sleep(200);
  facilitatore.emit('facilitatore:riprendi', { sessionId: sessione.id });
  await sleep(150);
  verifica('sessione non piu\' in pausa dopo facilitatore:riprendi', statoFacilitatore.inPausa === false);
  verifica('il timer del round e\' stato traslato in avanti della durata della pausa', statoFacilitatore.roundIniziatoIl > timerPrimaDellaPausa);

  socketTavolo.emit('tavolo:submitAzione', { sessionId: sessione.id, tavoloId: tavolo.id, collaboratoreId, azioneId: 'delega' });
  await sleep(150);
  verifica('dopo la ripresa, submitAzione torna a funzionare', statoTavolo.azioniSottomesseRound[collaboratoreId] === 'delega');

  // ---------- Backup / restore ----------
  const backupRes = await fetch(`${BASE}/api/sessioni/${sessione.id}/backup?tok=${tokenFacilitatore}`, { method: 'POST' });
  const { backup } = await backupRes.json();
  verifica('backup creato con successo', !!(backup && backup.backupId));

  const elencoRes = await fetch(`${BASE}/api/sessioni/${sessione.id}/backup?tok=${tokenFacilitatore}`);
  const { backups } = await elencoRes.json();
  verifica('backup elencato tra quelli disponibili', backups.some((b) => b.backupId === backup.backupId));

  // Modifica lo stato dopo il backup: chiudo il round (ora azione='delega' registrata verra' applicata)
  facilitatore.emit('facilitatore:chiudiRound', { sessionId: sessione.id });
  await sleep(200);
  verifica('stato cambiato dopo il backup (round chiuso)', statoFacilitatore.stato === 'round_chiuso' || statoFacilitatore.roundCorrente === 2);

  const restoreRes = await fetch(`${BASE}/api/sessioni/${sessione.id}/restore?tok=${tokenFacilitatore}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ backupId: backup.backupId })
  });
  const restoreBody = await restoreRes.json();
  verifica('restore risponde ok', restoreBody.ok === true);
  await sleep(200);

  const statoDopoRestoreRes = await fetch(`${BASE}/api/sessioni/${sessione.id}?tok=${tokenFacilitatore}`);
  const statoDopoRestore = await statoDopoRestoreRes.json();
  verifica('dopo il restore lo stato torna quello del backup (in_round, round 1)', statoDopoRestore.stato === 'in_round' && statoDopoRestore.roundCorrente === 1);
  verifica('il facilitatore riceve il broadcast dello stato ripristinato', statoFacilitatore.stato === 'in_round' && statoFacilitatore.roundCorrente === 1);

  // backup di una sessione non autorizzato senza token
  const backupSenzaToken = await fetch(`${BASE}/api/sessioni/${sessione.id}/backup`, { method: 'POST' });
  verifica('creazione backup senza token facilitatore rifiutata', backupSenzaToken.status === 403);

  console.log('=== TEST STRUMENTI OPERATIVI ===');
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
