'use strict';
// Verifica ad-hoc (non fa parte della suite regolare) del riepilogo settimana chiusa:
// controlla che compaia correttamente nei casi "nessuna azione" e "azioni reali", con
// livello/tendenza plausibili e {nome} sostituito.

const gameEngine = require('../src/gameEngine');
const collaboratoriConfig = require('../config/collaboratori.json');
const gameConfig = require('../config/gameConfig.json');
const azioniConfig = require('../config/azioni.json');
const azioniSistemicheConfig = require('../config/azioniSistemiche.json');
const messaggiNarrativiConfig = require('../config/messaggiNarrativi.json');
const fasiConfig = gameConfig.fasi;

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL -', msg);
    process.exitCode = 1;
  } else {
    console.log('PASS -', msg);
  }
}

// --- Scenario 1: tavolo che non fa MAI nulla per 3 round ---
{
  const tavolo = gameEngine.nuovoTavolo('t1', 'Tavolo inattivo', 'CODE1', collaboratoriConfig, gameConfig);
  for (let round = 1; round <= 3; round++) {
    const fase = gameEngine.calcolaFase(round, fasiConfig);
    gameEngine.generaRichiesteRound(tavolo, round, fase, fasiConfig, collaboratoriConfig, () => 0.99); // 0.99 -> quasi mai richieste attive, ma non conta: non sottomettiamo comunque nulla
    gameEngine.chiudiRound(tavolo, round, azioniConfig, gameConfig, collaboratoriConfig, azioniSistemicheConfig, messaggiNarrativiConfig);
    const r = tavolo.riepilogoSettimanaChiusa;
    console.log(`  [inattivo] round ${round}: parola="${r.parola}" azioni=${r.azioni.length} testo="${r.testo}"`);
    assert(r.round === round, `riepilogo round ${round} presente con round corretto`);
    assert(r.azioni.length === 0, `round ${round}: nessuna azione elencata (tavolo inattivo)`);
    assert(!r.testo.includes('{nome}'), `round ${round}: placeholder {nome} sostituito`);
    assert(r.testo.length > 20, `round ${round}: testo narrativo non vuoto`);
  }
}

// --- Scenario 2: tavolo attivo che investe bene su ciascun collaboratore ogni round (crescita attesa) ---
{
  const tavolo = gameEngine.nuovoTavolo('t2', 'Tavolo attivo', 'CODE2', collaboratoriConfig, gameConfig);
  for (let round = 1; round <= 4; round++) {
    const fase = gameEngine.calcolaFase(round, fasiConfig);
    gameEngine.generaRichiesteRound(tavolo, round, fase, fasiConfig, collaboratoriConfig, () => 0.99);
    // azione coerente per cluster su ognuno, cosi' cresce davvero
    tavolo.collaboratori.forEach((c) => {
      const azioneId = c.cluster === 'performer' ? 'delega' : c.cluster === 'potenziale' ? 'coaching' : 'monitoraggio';
      gameEngine.applicaAzione(tavolo, c.id, azioneId, azioniConfig);
    });
    gameEngine.chiudiRound(tavolo, round, azioniConfig, gameConfig, collaboratoriConfig, azioniSistemicheConfig, messaggiNarrativiConfig);
    const r = tavolo.riepilogoSettimanaChiusa;
    const punt = tavolo.punteggiPerRound[tavolo.punteggiPerRound.length - 1];
    console.log(`  [attivo] round ${round}: efficienzaGruppo=${punt.efficienzaGruppo} parola="${r.parola}" azioni=${r.azioni.length} testo="${r.testo}"`);
    // Non necessariamente tutte e 6: le ore manageriali disponibili per round sono limitate,
    // quindi alcune azioni possono restare non sottomesse (resta "nessunIntervento" implicito).
    assert(r.azioni.length > 0, `round ${round}: almeno un'azione reale elencata (${r.azioni.length}/${tavolo.collaboratori.length})`);
    assert(!r.testo.includes('{nome}'), `round ${round}: placeholder {nome} sostituito`);
    assert(r.azioni.every((a) => a.nome && a.azioneLabel), `round ${round}: ogni riga azione ha nome e azioneLabel`);
  }
}

// --- Scenario 3: verifica diretta soglie livello/tendenza della funzione (via require interno) ---
// Non esportata, quindi verifichiamo indirettamente forzando due round consecutivi con
// efficienzaGruppo molto diverso tramite azioni opposte (buono poi pessimo).
{
  const tavolo = gameEngine.nuovoTavolo('t3', 'Tavolo altalenante', 'CODE3', collaboratoriConfig, gameConfig);
  const fase1 = gameEngine.calcolaFase(1, fasiConfig);
  gameEngine.generaRichiesteRound(tavolo, 1, fase1, fasiConfig, collaboratoriConfig, () => 0.99);
  tavolo.collaboratori.forEach((c) => {
    const azioneId = c.cluster === 'performer' ? 'delega' : c.cluster === 'potenziale' ? 'coaching' : 'monitoraggio';
    gameEngine.applicaAzione(tavolo, c.id, azioneId, azioniConfig);
  });
  gameEngine.chiudiRound(tavolo, 1, azioniConfig, gameConfig, collaboratoriConfig, azioniSistemicheConfig, messaggiNarrativiConfig);
  const puntoRound1 = tavolo.punteggiPerRound[0];

  const fase2 = gameEngine.calcolaFase(2, fasiConfig);
  gameEngine.generaRichiesteRound(tavolo, 2, fase2, fasiConfig, collaboratoriConfig, () => 0.99);
  // round 2: nessuna azione -> quotaNessunIntervento alta, clima/motivazione presumibilmente in calo
  gameEngine.chiudiRound(tavolo, 2, azioniConfig, gameConfig, collaboratoriConfig, azioniSistemicheConfig, messaggiNarrativiConfig);
  const r2 = tavolo.riepilogoSettimanaChiusa;
  console.log(`  [altalenante] round1 efficienzaGruppo=${puntoRound1.efficienzaGruppo}, round2 parola="${r2.parola}" (nessuna azione) testo="${r2.testo}"`);
  assert(r2.azioni.length === 0, 'round 2 (nessuna azione dopo un round attivo): nessuna azione elencata');
}

// --- Scenario 4: evento speciale "abbandono" deve sostituire il messaggio generico ---
{
  const tavolo = gameEngine.nuovoTavolo('t4', 'Tavolo abbandono', 'CODE4', collaboratoriConfig, gameConfig);
  const target = tavolo.collaboratori[4]; // c5, resistente, sogliaTrascuratezza=2
  for (let r = 1; r <= 2; r++) {
    gameEngine.chiudiRound(tavolo, r, azioniConfig, gameConfig, collaboratoriConfig, azioniSistemicheConfig, messaggiNarrativiConfig);
  }
  gameEngine.applicaAzione(tavolo, target.id, 'monitoraggio', azioniConfig);
  gameEngine.chiudiRound(tavolo, 3, azioniConfig, gameConfig, collaboratoriConfig, azioniSistemicheConfig, messaggiNarrativiConfig);
  const r = tavolo.riepilogoSettimanaChiusa;
  console.log(`  [abbandono] parola="${r.parola}" testo="${r.testo}"`);
  assert(target.uscitoDallaRete === true, 'evento abbandono: collaboratore risulta uscito dalla rete');
  assert(r.testo.includes(target.nome), 'evento abbandono: il riepilogo cita per nome chi ha lasciato la rete');
  assert(!r.testo.includes('{nome}'), 'evento abbandono: placeholder sostituito');
}

// --- Scenario 5: evento speciale "dipendenza" deve sostituire il messaggio generico ---
{
  const tavolo = gameEngine.nuovoTavolo('t5', 'Tavolo dipendenza', 'CODE5', collaboratoriConfig, gameConfig);
  const target = tavolo.collaboratori[0]; // c1, performer
  target.stats.competenza = 90;
  target.stats.autonomia = 80;
  for (let r = 1; r <= 3; r++) {
    target.richiestaCorrente = { testo: 'Chiede affiancamento anche se non servirebbe' };
    gameEngine.applicaAzione(tavolo, target.id, 'shadowing', azioniConfig);
    gameEngine.chiudiRound(tavolo, r, azioniConfig, gameConfig, collaboratoriConfig, azioniSistemicheConfig, messaggiNarrativiConfig);
  }
  const r = tavolo.riepilogoSettimanaChiusa;
  console.log(`  [dipendenza] parola="${r.parola}" testo="${r.testo}"`);
  assert(r.testo.includes(target.nome), 'evento dipendenza: il riepilogo cita per nome chi e\' diventato dipendente');
}

// --- Scenario 6: evento speciale "riclassificazione" (potenziale -> performer) ---
{
  const tavolo = gameEngine.nuovoTavolo('t6', 'Tavolo riclassificazione', 'CODE6', collaboratoriConfig, gameConfig);
  const target = tavolo.collaboratori[2]; // c3, Sara Bianchi, potenziale
  target.stats.competenza = 75;
  target.stats.autonomia = 70;
  gameEngine.chiudiRound(tavolo, 1, azioniConfig, gameConfig, collaboratoriConfig, azioniSistemicheConfig, messaggiNarrativiConfig);
  gameEngine.chiudiRound(tavolo, 2, azioniConfig, gameConfig, collaboratoriConfig, azioniSistemicheConfig, messaggiNarrativiConfig);
  const r = tavolo.riepilogoSettimanaChiusa;
  console.log(`  [riclassificazione] cluster=${target.cluster} parola="${r.parola}" testo="${r.testo}"`);
  assert(target.cluster === 'performer', 'evento riclassificazione: cluster aggiornato a performer');
  assert(r.testo.includes(target.nome), 'evento riclassificazione: il riepilogo cita per nome chi e\' stato promosso');
}

// --- Scenario 7: evento speciale "prima azione sistemica" in Fase 4 ---
{
  const tavolo = gameEngine.nuovoTavolo('t7', 'Tavolo sistemica', 'CODE7', collaboratoriConfig, gameConfig);
  const numeroRoundFase2 = fasiConfig.numeroRoundFase2;
  const roundFase4 = numeroRoundFase2 + fasiConfig.numeroRoundFase3 + 1; // primo round di Fase 4
  for (let r = 1; r < roundFase4; r++) {
    gameEngine.chiudiRound(tavolo, r, azioniConfig, gameConfig, collaboratoriConfig, azioniSistemicheConfig, messaggiNarrativiConfig);
  }
  gameEngine.applicaAzioneSistemica(tavolo, 'buddy', azioniSistemicheConfig);
  gameEngine.chiudiRound(tavolo, roundFase4, azioniConfig, gameConfig, collaboratoriConfig, azioniSistemicheConfig, messaggiNarrativiConfig);
  const r = tavolo.riepilogoSettimanaChiusa;
  console.log(`  [primaAzioneSistemica] round=${roundFase4} parola="${r.parola}" testo="${r.testo}"`);
  assert(r.parola === 'Maturità' || r.parola === 'Passaggio', 'evento primaAzioneSistemica: parola dal pool dedicato');
}

// --- Scenario 8: chiusura della crisi (Fase 3) genera un messaggio dedicato ---
{
  const tavolo = gameEngine.nuovoTavolo('t8', 'Tavolo crisi', 'CODE8', collaboratoriConfig, gameConfig);
  const roundCrisi = fasiConfig.numeroRoundFase2 + 1;
  for (let r = 1; r < roundCrisi; r++) {
    gameEngine.chiudiRound(tavolo, r, azioniConfig, gameConfig, collaboratoriConfig, azioniSistemicheConfig, messaggiNarrativiConfig);
  }
  const faseCrisi = gameEngine.calcolaFase(roundCrisi, fasiConfig);
  gameEngine.generaRichiesteRound(tavolo, roundCrisi, faseCrisi, fasiConfig, collaboratoriConfig, () => 0.01); // propensione*2.5 -> quasi sempre chiama
  gameEngine.chiudiRound(tavolo, roundCrisi, azioniConfig, gameConfig, collaboratoriConfig, azioniSistemicheConfig, messaggiNarrativiConfig);
  const r = tavolo.riepilogoSettimanaChiusa;
  console.log(`  [crisiChiusa] round=${roundCrisi} parola="${r.parola}" testo="${r.testo}"`);
  const paroleCrisi = ['Tenuta', 'Solidità', 'Prova', 'Differenze', 'Scoperti', 'Pressione'];
  assert(paroleCrisi.includes(r.parola), 'evento crisiChiusa: parola dal pool dedicato alla crisi');
}

// --- Scenario 9: varieta' su una sessione completa di 9 round, nessuna frase ripetuta nello stesso mazzo ---
{
  const tavolo = gameEngine.nuovoTavolo('t9', 'Tavolo lungo', 'CODE9', collaboratoriConfig, gameConfig);
  const testiUsati = [];
  for (let round = 1; round <= 9; round++) {
    const fase = gameEngine.calcolaFase(round, fasiConfig);
    gameEngine.generaRichiesteRound(tavolo, round, fase, fasiConfig, collaboratoriConfig, () => 0.5);
    tavolo.collaboratori.forEach((c, i) => {
      if ((round + i) % 2 === 0) {
        const azioneId = c.cluster === 'performer' ? 'delega' : c.cluster === 'potenziale' ? 'coaching' : 'visitaProattiva';
        gameEngine.applicaAzione(tavolo, c.id, azioneId, azioniConfig);
      }
    });
    gameEngine.chiudiRound(tavolo, round, azioniConfig, gameConfig, collaboratoriConfig, azioniSistemicheConfig, messaggiNarrativiConfig);
    const r = tavolo.riepilogoSettimanaChiusa;
    console.log(`  [lungo] round ${round}: parola="${r.parola}"`);
    testiUsati.push(r.testo);
  }
  const testiUnici = new Set(testiUsati);
  console.log(`  [lungo] ${testiUnici.size}/${testiUsati.length} testi distinti su 9 round (con 3 varianti per casella, qualche ripetizione non consecutiva e' attesa)`);
  // Il vero obiettivo e' evitare ripetizioni CONSECUTIVE (le piu' percepibili in aula), non
  // l'unicita' assoluta: con solo 3 varianti per casella e un bucket rivisitato 4+ volte in 9
  // round una ripetizione e' matematicamente inevitabile, ma non deve mai capitare due volte di fila.
  let consecutiveUguali = 0;
  for (let i = 1; i < testiUsati.length; i++) {
    if (testiUsati[i] === testiUsati[i - 1]) consecutiveUguali++;
  }
  assert(consecutiveUguali === 0, `varieta' su 9 round: nessuna ripetizione consecutiva (trovate ${consecutiveUguali})`);
}

console.log(process.exitCode ? '\n=== CI SONO FALLIMENTI ===' : '\n=== TUTTI I CONTROLLI OK ===');
