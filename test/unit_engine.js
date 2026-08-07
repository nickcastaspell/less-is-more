'use strict';
/**
 * Test unitario del motore (senza server/socket): verifica in modo deterministico
 * calcolo fase, generazione richieste (incl. garanzia turno silenzioso), azioni
 * sistemiche e messaggi narrativi (dipendenza/abbandono).
 */
const assert = require('assert');
const gameEngine = require('../src/gameEngine');
const collaboratoriConfig = require('../config/collaboratori.json');
const azioniConfig = require('../config/azioni.json');
const azioniSistemicheConfig = require('../config/azioniSistemiche.json');
const gameConfig = require('../config/gameConfig.json');
const messaggiNarrativiConfig = require('../config/messaggiNarrativi.json');
const epilogoConfig = require('../config/epilogo.json');

const risultati = [];
function verifica(desc, condizione) {
  risultati.push([desc, !!condizione]);
}

// ---------- calcolaFase ----------
const fasiConfig = gameConfig.fasi; // numeroRoundFase2:5, numeroRoundFase3:1, numeroRoundFase4:3
verifica('round 1 -> fase 2', gameEngine.calcolaFase(1, fasiConfig) === 2);
verifica('round 5 -> fase 2', gameEngine.calcolaFase(5, fasiConfig) === 2);
verifica('round 6 -> fase 3 (crisi)', gameEngine.calcolaFase(6, fasiConfig) === 3);
verifica('round 7 -> fase 4', gameEngine.calcolaFase(7, fasiConfig) === 4);
verifica('round 9 -> fase 4', gameEngine.calcolaFase(9, fasiConfig) === 4);
verifica('numeroRoundTotali = 9', gameEngine.numeroRoundTotali(fasiConfig) === 9);

// ---------- generaRichiesteRound: garanzia turno silenzioso ----------
const tavoloA = gameEngine.nuovoTavolo('tA', 'Tavolo A', 'CODEA', collaboratoriConfig, gameConfig);
tavoloA.collaboratori.forEach((c) => { c.propensioneRichiesta = 100; }); // sempre "chiamerebbero"
for (let r = 1; r <= 4; r++) {
  gameEngine.generaRichiesteRound(tavoloA, r, 2, fasiConfig, collaboratoriConfig);
}
const ultimoStorico = tavoloA.storicoRichieste[tavoloA.storicoRichieste.length - 1];
verifica('turno silenzioso forzato al round 4 (finestra [2,4])', ultimoStorico.round === 4 && ultimoStorico.numeroRichieste === 0);
verifica('turnoSilenziosoOccorso = true dopo la finestra', tavoloA.turnoSilenziosoOccorso === true);
verifica('nessuna richiesta attiva sui collaboratori al round forzato', tavoloA.collaboratori.every((c) => c.richiestaCorrente === null));

// ---------- generaRichiesteRound: propensione 0 -> mai richieste, si accorge naturalmente ----------
const tavoloB = gameEngine.nuovoTavolo('tB', 'Tavolo B', 'CODEB', collaboratoriConfig, gameConfig);
tavoloB.collaboratori.forEach((c) => { c.propensioneRichiesta = 0; });
gameEngine.generaRichiesteRound(tavoloB, 2, 2, fasiConfig, collaboratoriConfig);
verifica('propensione 0 -> zero richieste naturali', tavoloB.storicoRichieste[0].numeroRichieste === 0);
verifica('turno silenzioso riconosciuto naturalmente (non serve forzare)', tavoloB.turnoSilenziosoOccorso === true);

// ---------- crisi: moltiplicatore propensione ----------
const tavoloC = gameEngine.nuovoTavolo('tC', 'Tavolo C', 'CODEC', collaboratoriConfig, gameConfig);
tavoloC.collaboratori.forEach((c) => { c.propensioneRichiesta = 50; });
gameEngine.generaRichiesteRound(tavoloC, 6, 3, fasiConfig, collaboratoriConfig); // fase 3, propensione*2.5 = 125 -> sempre true
verifica('in crisi, propensione moltiplicata genera richieste da tutti', tavoloC.storicoRichieste[0].numeroRichieste === tavoloC.collaboratori.length);

// ---------- azioni sistemiche ----------
const tavoloD = gameEngine.nuovoTavolo('tD', 'Tavolo D', 'CODED', collaboratoriConfig, gameConfig);
const autonomiaPrimaD = tavoloD.collaboratori.map((c) => c.stats.autonomia);
const risultatoSubmit = gameEngine.applicaAzioneSistemica(tavoloD, 'buddy', azioniSistemicheConfig);
verifica('azione sistemica sottomessa con successo', risultatoSubmit.ok === true && risultatoSubmit.selezionata === true);
gameEngine.chiudiRound(tavoloD, 1, azioniConfig, gameConfig, collaboratoriConfig, azioniSistemicheConfig, messaggiNarrativiConfig);
verifica('modificatorePropensioneSistemica sceso dopo azione buddy', tavoloD.modificatorePropensioneSistemica === -8);
verifica('autonomia media cresciuta per tutti dopo azione sistemica', tavoloD.collaboratori.every((c, i) => c.stats.autonomia >= autonomiaPrimaD[i]));
verifica('azioniSistemicheLog registrato', tavoloD.azioniSistemicheLog.length === 1 && tavoloD.azioniSistemicheLog[0].azioneSistemicaId === 'buddy');
verifica('azioniSistemicheSottomesseRound resettato dopo chiusura round', tavoloD.azioniSistemicheSottomesseRound.length === 0);
verifica('ore azione sistemica (buddy, 3h) incluse in metriche.oreTotali', tavoloD.metriche.oreTotali === 3);
verifica('ore azione sistemica tracciate anche in metriche.oreSistemicheTotali', tavoloD.metriche.oreSistemicheTotali === 3);

// ---------- PRNG seedato: stessa sequenza per stesso seed, sequenze diverse per seed diversi ----------
const seedRound1 = gameEngine.seedDaStringa('sessioneX:1');
const seedRound1Bis = gameEngine.seedDaStringa('sessioneX:1');
const seedRound2 = gameEngine.seedDaStringa('sessioneX:2');
verifica('seedDaStringa deterministico per la stessa stringa', seedRound1 === seedRound1Bis);
verifica('seedDaStringa differenzia round diversi', seedRound1 !== seedRound2);

const tavoloF1 = gameEngine.nuovoTavolo('tF1', 'Tavolo F1', 'CODEF1', collaboratoriConfig, gameConfig);
const tavoloF2 = gameEngine.nuovoTavolo('tF2', 'Tavolo F2', 'CODEF2', collaboratoriConfig, gameConfig);
gameEngine.generaRichiesteRound(tavoloF1, 1, 2, fasiConfig, collaboratoriConfig, gameEngine.creaGeneratoreSeeded(seedRound1));
gameEngine.generaRichiesteRound(tavoloF2, 1, 2, fasiConfig, collaboratoriConfig, gameEngine.creaGeneratoreSeeded(seedRound1));
const richiesteF1 = tavoloF1.collaboratori.map((c) => (c.richiestaCorrente ? c.richiestaCorrente.testo : null));
const richiesteF2 = tavoloF2.collaboratori.map((c) => (c.richiestaCorrente ? c.richiestaCorrente.testo : null));
verifica('stesso seed -> stessa sequenza di richieste tra due tavoli', JSON.stringify(richiesteF1) === JSON.stringify(richiesteF2));

const tavoloF3 = gameEngine.nuovoTavolo('tF3', 'Tavolo F3', 'CODEF3', collaboratoriConfig, gameConfig);
gameEngine.generaRichiesteRound(tavoloF3, 2, 2, fasiConfig, collaboratoriConfig, gameEngine.creaGeneratoreSeeded(seedRound2));
const richiesteF3 = tavoloF3.collaboratori.map((c) => (c.richiestaCorrente ? c.richiestaCorrente.testo : null));
verifica('seed diverso (round diverso) -> sequenza diversa', JSON.stringify(richiesteF1) !== JSON.stringify(richiesteF3));

// toggle: sottomettere due volte la stessa azione sistemica la rimuove (deseleziona)
const tavoloD2 = gameEngine.nuovoTavolo('tD2', 'Tavolo D2', 'CODED2', collaboratoriConfig, gameConfig);
gameEngine.applicaAzioneSistemica(tavoloD2, 'checklist', azioniSistemicheConfig);
const oreDopoSelezione = tavoloD2.oreUsateRound;
const risultatoToggle = gameEngine.applicaAzioneSistemica(tavoloD2, 'checklist', azioniSistemicheConfig);
verifica('deselezionare un\'azione sistemica libera le ore', risultatoToggle.selezionata === false && tavoloD2.oreUsateRound === 0 && oreDopoSelezione > 0);

// ---------- messaggio narrativo: abbandono ----------
const tavoloE = gameEngine.nuovoTavolo('tE', 'Tavolo E', 'CODEE', collaboratoriConfig, gameConfig);
const targetAbbandono = tavoloE.collaboratori[4]; // c5, resistente
for (let r = 1; r <= 3; r++) {
  // nessuna azione sottomessa per targetAbbandono -> conta come nessunIntervento in chiusura
  gameEngine.chiudiRound(tavoloE, r, azioniConfig, gameConfig, collaboratoriConfig, azioniSistemicheConfig, messaggiNarrativiConfig);
}
verifica('dopo 3 round trascurato, roundConsecutiviTrascurato >= 3', targetAbbandono.roundConsecutiviTrascurato >= 3);
gameEngine.applicaAzione(tavoloE, targetAbbandono.id, 'monitoraggio', azioniConfig);
gameEngine.chiudiRound(tavoloE, 4, azioniConfig, gameConfig, collaboratoriConfig, azioniSistemicheConfig, messaggiNarrativiConfig);
const messaggioAbbandono = tavoloE.messaggiNarrativiRound.find((m) => m.tipo === 'abbandono' && m.collaboratoreId === targetAbbandono.id);
verifica('messaggio di abbandono generato al round 4', !!messaggioAbbandono);
verifica('collaboratore contrassegnato come uscito dalla rete', targetAbbandono.uscitoDallaRete === true);

// ---------- messaggio narrativo: dipendenza ----------
const tavoloF = gameEngine.nuovoTavolo('tF', 'Tavolo F', 'CODEF', collaboratoriConfig, gameConfig);
const targetDipendenza = tavoloF.collaboratori[0]; // c1, performer, gia' competenza/autonomia alte
targetDipendenza.stats.competenza = 90;
targetDipendenza.stats.autonomia = 80;
for (let r = 1; r <= 3; r++) {
  targetDipendenza.richiestaCorrente = { testo: 'Chiede affiancamento anche se non servirebbe' };
  gameEngine.applicaAzione(tavoloF, targetDipendenza.id, 'shadowing', azioniConfig);
  gameEngine.chiudiRound(tavoloF, r, azioniConfig, gameConfig, collaboratoriConfig, azioniSistemicheConfig, messaggiNarrativiConfig);
}
verifica('usiConsecutiviAffiancamento >= 3', targetDipendenza.usiConsecutiviAffiancamento >= 3);
const messaggioDipendenza = tavoloF.messaggiNarrativiRound.find((m) => m.tipo === 'dipendenza' && m.collaboratoreId === targetDipendenza.id);
verifica('messaggio di dipendenza generato al terzo round consecutivo', !!messaggioDipendenza);

// ---------- assegnaCategoria ----------
const tavoloG = gameEngine.nuovoTavolo('tG', 'Tavolo G', 'CODEG', collaboratoriConfig, gameConfig);
gameEngine.assegnaCategoria(tavoloG, tavoloG.collaboratori[0].id, 'Investirei', 0);
gameEngine.assegnaCategoria(tavoloG, tavoloG.collaboratori[0].id, 'Monitorerei', 3); // il tavolo cambia idea dopo
verifica('categoria assegnata aggiornabile', tavoloG.collaboratori[0].categoriaAssegnata === 'Monitorerei');
verifica('storico categoria tiene traccia dei cambi', tavoloG.collaboratori[0].categoriaStorico.length === 2);

// ---------- impatto narrativo della crisi (Fase 3) ----------
// Con numeroRoundFase2:5 e numeroRoundFase3:1, il round 6 e' l'unico round di crisi.
const tavoloH = gameEngine.nuovoTavolo('tH', 'Tavolo H', 'CODEH', collaboratoriConfig, gameConfig);
tavoloH.collaboratori[0].richiestaCorrente = { testo: 'Richiesta 1' };
tavoloH.collaboratori[1].richiestaCorrente = { testo: 'Richiesta 2' };
gameEngine.applicaAzione(tavoloH, tavoloH.collaboratori[0].id, 'monitoraggio', azioniConfig); // questa viene "gestita"
// collaboratori[1] resta senza azione sottomessa -> conta come nessunIntervento, richiesta non gestita
gameEngine.chiudiRound(tavoloH, 6, azioniConfig, gameConfig, collaboratoriConfig, azioniSistemicheConfig, messaggiNarrativiConfig);
verifica('impattoCrisi calcolato alla chiusura del round di Fase 3', !!tavoloH.impattoCrisi);
verifica('impattoCrisi conta correttamente richieste/gestite/non gestite', tavoloH.impattoCrisi && tavoloH.impattoCrisi.richieste === 2 && tavoloH.impattoCrisi.gestite === 1 && tavoloH.impattoCrisi.nonGestite === 1);
verifica('impattoCrisi non generato nei round non di crisi', tavoloD.impattoCrisi === null);

// ---------- messaggio narrativo Fase 4: calo delle richieste al manager ----------
const tavoloCalo = gameEngine.nuovoTavolo('tCalo', 'Tavolo Calo', 'CODECALO', collaboratoriConfig, gameConfig);
tavoloCalo.storicoRichieste = [1, 2, 3, 4, 5].map((r) => ({ round: r, numeroRichieste: 5 })); // media Fase2 = 5
tavoloCalo.azioniSistemicheLog.push({ round: 7, azioneSistemicaId: 'buddy' }); // azione sistemica gia' attivata in precedenza
tavoloCalo.storicoRichieste.push({ round: 8, numeroRichieste: 2 }); // calo del 60% >= soglia 30%
gameEngine.chiudiRound(tavoloCalo, 8, azioniConfig, gameConfig, collaboratoriConfig, azioniSistemicheConfig, messaggiNarrativiConfig);
verifica('messaggio di calo richieste generato in Fase 4 dopo azione sistemica', tavoloCalo.messaggiNarrativiRound.some((m) => m.tipo === 'sistemaMaturo'));
verifica('flag messaggioCaloRichiesteMostrato impostato', tavoloCalo.messaggioCaloRichiesteMostrato === true);

tavoloCalo.storicoRichieste.push({ round: 9, numeroRichieste: 1 });
gameEngine.chiudiRound(tavoloCalo, 9, azioniConfig, gameConfig, collaboratoriConfig, azioniSistemicheConfig, messaggiNarrativiConfig);
verifica('messaggio di calo richieste mostrato una sola volta a sessione', !tavoloCalo.messaggiNarrativiRound.some((m) => m.tipo === 'sistemaMaturo'));

// ---------- epilogo narrativo "settimana senza di voi" ----------
function fabbricaTavoloPerEpilogo({ autonomiaMedia, rischioTurnoverMedio, usciti = [] }) {
  const t = gameEngine.nuovoTavolo('tEpi', 'Tavolo Epi', 'CODEEPI', collaboratoriConfig, gameConfig);
  t.punteggiPerRound = [{ round: 9, autonomiaMedia, rischioTurnoverMedio }];
  usciti.forEach((idx) => { t.collaboratori[idx].uscitoDallaRete = true; });
  return t;
}

const epilogoAutonomo = gameEngine.calcolaEpilogo(fabbricaTavoloPerEpilogo({ autonomiaMedia: 70, rischioTurnoverMedio: 20 }), epilogoConfig);
verifica('epilogo "rete_autonoma" per alta autonomia e basso rischio', epilogoAutonomo && epilogoAutonomo.id === 'rete_autonoma');

const epilogoRischio = gameEngine.calcolaEpilogo(fabbricaTavoloPerEpilogo({ autonomiaMedia: 50, rischioTurnoverMedio: 60 }), epilogoConfig);
verifica('epilogo "rete_a_rischio" per alto rischio turnover', epilogoRischio && epilogoRischio.id === 'rete_a_rischio');

const epilogoDipendente = gameEngine.calcolaEpilogo(fabbricaTavoloPerEpilogo({ autonomiaMedia: 30, rischioTurnoverMedio: 20 }), epilogoConfig);
verifica('epilogo "rete_dipendente" per bassa autonomia', epilogoDipendente && epilogoDipendente.id === 'rete_dipendente');

const tavoloEpiCrisi = fabbricaTavoloPerEpilogo({ autonomiaMedia: 70, rischioTurnoverMedio: 20, usciti: [4] });
const epilogoCrisi = gameEngine.calcolaEpilogo(tavoloEpiCrisi, epilogoConfig);
verifica('epilogo "rete_in_crisi" ha priorita\' su tutto se qualcuno e\' uscito', epilogoCrisi && epilogoCrisi.id === 'rete_in_crisi');
verifica('epilogo "rete_in_crisi" cita per nome chi e\' uscito', epilogoCrisi.testo.includes(tavoloEpiCrisi.collaboratori[4].nome));

const epilogoMisto = gameEngine.calcolaEpilogo(fabbricaTavoloPerEpilogo({ autonomiaMedia: 50, rischioTurnoverMedio: 35 }), epilogoConfig);
verifica('epilogo "rete_in_transizione" come fallback', epilogoMisto && epilogoMisto.id === 'rete_in_transizione');

// ---------- report ----------
console.log('=== TEST UNITARIO MOTORE (4 fasi) ===');
let tuttoOk = true;
for (const [desc, ok] of risultati) {
  console.log(ok ? 'PASS' : 'FAIL', '-', desc);
  if (!ok) tuttoOk = false;
}
process.exit(tuttoOk ? 0 : 1);
