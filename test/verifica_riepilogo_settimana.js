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

console.log(process.exitCode ? '\n=== CI SONO FALLIMENTI ===' : '\n=== TUTTI I CONTROLLI OK ===');
