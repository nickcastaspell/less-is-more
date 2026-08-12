'use strict';

/**
 * Motore di gioco: applicazione azioni, chiusura round, calcolo punteggi.
 * Tutta la logica di bilanciamento vive nei file JSON in /config, cosi'
 * puo' essere modificata senza toccare questo codice.
 */

function clamp(v, min = 0, max = 100) {
  return Math.max(min, Math.min(max, v));
}

// --- PRNG deterministico (mulberry32) per garantire equita' tra tavoli: usato per
// generare le richieste in modo che, nello stesso round, ogni tavolo affronti la
// stessa sequenza (non necessariamente lo stesso risultato di sessione in sessione). ---
function seedDaStringa(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

function creaGeneratoreSeeded(seed) {
  let s = seed >>> 0;
  return function rng() {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function creaCollaboratoriPerTavolo(templateSquadra, collaboratoriConfig) {
  return templateSquadra.map((c) => ({
    id: c.id,
    nome: c.nome,
    cluster: c.cluster,
    stats: { ...c.stats },
    statsIniziali: { ...c.stats },
    rischioTurnover: 0,
    roundConsecutiviMotivazioneBassa: 0,
    roundConsecutiviTrascurato: 0,
    effettiDifferitiPendenti: {},
    ultimaAzione: null,
    usiConsecutiviSurroga: 0,
    // --- Fase 1-4 ---
    categoriaAssegnata: null, // etichetta scelta dal tavolo in Fase 1 (es. "Investirei"), non il cluster reale
    categoriaStorico: [], // [{ round, categoria }]
    // propensioneRichiesta: se valorizzato esplicitamente (es. dai test), sovrascrive la formula
    // basata sull'autonomia in generaRichiesteRound. Di norma resta null: la propensione a
    // chiamare NON dipende dal cluster, ma viene ricalcolata ogni round dall'autonomia corrente
    // (vedi collaboratoriConfig.formulaPropensioneChiamata).
    propensioneRichiesta: null,
    richiestaCorrente: null, // { testo } | null, generata a inizio round
    usiConsecutiviAffiancamento: 0, // per il messaggio narrativo di dipendenza
    uscitoDallaRete: false, // esito del messaggio narrativo di abbandono
    // storicoStats: uno snapshot delle stat visibili alla chiusura di ogni round, usato per
    // calcolare le frecce di tendenza (confronto con la media mobile delle rilevazioni precedenti)
    // senza dover ricalcolare a ritroso gli effetti gia' applicati.
    storicoStats: [],
    // cronologia: log leggibile round per round (richiesta ricevuta, azione scelta, se gestita),
    // usato dalla scheda "cronologia" cliccabile lato tavolo.
    cronologia: []
  }));
}

function nuovoTavolo(id, nome, codiceAccesso, collaboratoriConfig, gameConfig) {
  return {
    id,
    nome,
    codiceAccesso,
    collaboratori: creaCollaboratoriPerTavolo(collaboratoriConfig.templateSquadra, collaboratoriConfig),
    oreDisponibiliRound: gameConfig.oreManagerialiPerRound,
    oreUsateRound: 0,
    azioniSottomesseRound: {}, // { collaboratoreId: azioneId }
    confermato: false,
    climaTeam: 70,
    log: [], // { round, collaboratoreId, azioneId, costoOre, cluster }
    punteggiPerRound: [],
    metriche: {
      oreTotaliPerCollaboratore: {},
      oreTotali: 0,
      oreSistemicheTotali: 0, // ore spese in azioni sistemiche di Fase 4 (incluse anche in oreTotali)
      conteggioAzioni: {},
      azioniCoerentiCount: 0,
      azioniTotaliCount: 0,
      allocazionePerRound: [] // array di { collabId: oreSpese } per round, per calcolare reattivita
    },
    // --- Fase 1-4 ---
    modificatorePropensioneSistemica: 0, // cumulato dalle azioni sistemiche di Fase 4
    storicoRichieste: [], // [{ round, numeroRichieste }] -> indicatore "richieste al manager"
    turnoSilenziosoOccorso: false,
    messaggiNarrativiRound: [], // messaggi narrativi generati alla chiusura dell'ultimo round
    azioniSistemicheSottomesseRound: [], // [azioneSistemicaId] scelte questo round (Fase 4)
    azioniSistemicheLog: [], // [{ round, azioneSistemicaId }]
    impattoCrisi: null, // { round, richieste, gestite, nonGestite, testo } calcolato alla chiusura del round di Fase 3
    messaggioCaloRichiesteMostrato: false // garantisce che il messaggio narrativo di Fase 4 sul calo richieste compaia una sola volta
  };
}

// Assegna/aggiorna la categoria che il tavolo attribuisce a un collaboratore (Fase 1, modificabile in seguito).
function assegnaCategoria(tavolo, collaboratoreId, categoria, round) {
  const collaboratore = tavolo.collaboratori.find((c) => c.id === collaboratoreId);
  if (!collaboratore) return { ok: false, motivo: 'collaboratore_sconosciuto' };
  collaboratore.categoriaAssegnata = categoria;
  collaboratore.categoriaStorico.push({ round, categoria });
  return { ok: true };
}

// Determina in quale fase (2, 3 o 4) ricade un dato numero di round, in base alla configurazione.
function calcolaFase(roundCorrente, fasiConfig) {
  if (roundCorrente <= fasiConfig.numeroRoundFase2) return 2;
  if (roundCorrente <= fasiConfig.numeroRoundFase2 + fasiConfig.numeroRoundFase3) return 3;
  return 4;
}

function numeroRoundTotali(fasiConfig) {
  return fasiConfig.numeroRoundFase2 + fasiConfig.numeroRoundFase3 + fasiConfig.numeroRoundFase4;
}

// Genera le richieste in arrivo per il round che sta per iniziare (chiamata da facilitatore:avviaRound).
// `rng` e' una funzione 0-1 iniettabile (di default Math.random): il chiamante puo' passare
// un generatore seedato in modo che, nello stesso round, tutti i tavoli affrontino la stessa
// sequenza di richieste (equita' competitiva tra tavoli).
function generaRichiesteRound(tavolo, roundCorrente, fase, fasiConfig, collaboratoriConfig, rng = Math.random) {
  const attivi = tavolo.collaboratori.filter((c) => !c.uscitoDallaRete);
  const moltiplicatore = fase === 3 ? fasiConfig.crisi.moltiplicatorePropensione : 1;
  const formula = collaboratoriConfig.formulaPropensioneChiamata || { base: 70, fattoreAutonomia: 0, min: 10, max: 90 };

  let numeroRichieste = 0;
  for (const collaboratore of attivi) {
    // La probabilita' di chiamata NON dipende dal cluster: dipende dall'autonomia corrente del
    // collaboratore (ricalcolata round per round, quindi risponde alle azioni fatte finora).
    // Un override esplicito su propensioneRichiesta (es. nei test) ha comunque priorita'.
    const propensioneBase = (collaboratore.propensioneRichiesta !== null && collaboratore.propensioneRichiesta !== undefined)
      ? collaboratore.propensioneRichiesta
      : clamp(formula.base - (collaboratore.stats.autonomia || 0) * formula.fattoreAutonomia, formula.min, formula.max);

    const propensioneEffettiva = clamp(
      propensioneBase + tavolo.modificatorePropensioneSistemica,
      0, 100
    ) * moltiplicatore;

    const chiama = rng() * 100 < propensioneEffettiva;
    if (chiama) {
      const testiPossibili = (collaboratoriConfig.clusterDefinitions[collaboratore.cluster] || {}).richiesteTipiche || [];
      const testo = testiPossibili.length > 0
        ? testiPossibili[Math.floor(rng() * testiPossibili.length)]
        : 'Chiede un confronto';
      collaboratore.richiestaCorrente = { testo };
      numeroRichieste += 1;
    } else {
      collaboratore.richiestaCorrente = null;
    }
  }

  // Garanzia del "turno silenzioso" entro la finestra configurata, solo in Fase 2.
  if (fase === 2 && Array.isArray(fasiConfig.finestraTurnoSilenzioso)) {
    const [inizioFinestra, fineFinestra] = fasiConfig.finestraTurnoSilenzioso;
    if (numeroRichieste === 0 && roundCorrente >= inizioFinestra && roundCorrente <= fineFinestra) {
      tavolo.turnoSilenziosoOccorso = true;
    }
    if (roundCorrente === fineFinestra && !tavolo.turnoSilenziosoOccorso) {
      attivi.forEach((c) => { c.richiestaCorrente = null; });
      numeroRichieste = 0;
      tavolo.turnoSilenziosoOccorso = true;
    }
  }

  tavolo.storicoRichieste.push({ round: roundCorrente, numeroRichieste });
  return numeroRichieste;
}

// Sceglie/toglie un'azione sistemica per questo round (Fase 4). Costa ore dallo stesso monte ore del round.
function applicaAzioneSistemica(tavolo, azioneSistemicaId, azioniSistemicheConfig) {
  const azione = azioniSistemicheConfig.azioniSistemiche[azioneSistemicaId];
  if (!azione) return { ok: false, motivo: 'azione_sconosciuta' };

  const giaScelta = tavolo.azioniSistemicheSottomesseRound.includes(azioneSistemicaId);
  if (giaScelta) {
    tavolo.azioniSistemicheSottomesseRound = tavolo.azioniSistemicheSottomesseRound.filter((id) => id !== azioneSistemicaId);
    tavolo.oreUsateRound -= azione.costoOre;
    return { ok: true, oreResidue: tavolo.oreDisponibiliRound - tavolo.oreUsateRound, selezionata: false };
  }

  const oreResidue = tavolo.oreDisponibiliRound - tavolo.oreUsateRound;
  if (azione.costoOre > oreResidue) {
    return { ok: false, motivo: 'ore_insufficienti', oreResidue };
  }
  tavolo.azioniSistemicheSottomesseRound.push(azioneSistemicaId);
  tavolo.oreUsateRound += azione.costoOre;
  return { ok: true, oreResidue: tavolo.oreDisponibiliRound - tavolo.oreUsateRound, selezionata: true };
}

function applicaEffetti(stats, effetti) {
  if (!effetti) return;
  for (const [chiave, delta] of Object.entries(effetti)) {
    if (chiave === 'climaTeam') continue; // gestito a livello di tavolo
    if (stats[chiave] === undefined) continue;
    stats[chiave] = clamp(stats[chiave] + delta);
  }
}

function applicaAzione(tavolo, collaboratoreId, azioneId, azioniConfig) {
  const azione = azioniConfig.azioni[azioneId];
  if (!azione) throw new Error('Azione sconosciuta: ' + azioneId);

  const collaboratore = tavolo.collaboratori.find((c) => c.id === collaboratoreId);
  if (!collaboratore) throw new Error('Collaboratore sconosciuto: ' + collaboratoreId);

  const oreResidue = tavolo.oreDisponibiliRound - tavolo.oreUsateRound;
  const azionePrecedente = tavolo.azioniSottomesseRound[collaboratoreId];
  const costoNetto = azionePrecedente
    ? azione.costoOre - azioniConfig.azioni[azionePrecedente].costoOre
    : azione.costoOre;

  if (costoNetto > oreResidue) {
    return { ok: false, motivo: 'ore_insufficienti', oreResidue };
  }

  tavolo.azioniSottomesseRound[collaboratoreId] = azioneId;
  tavolo.oreUsateRound += costoNetto;

  return { ok: true, oreResidue: tavolo.oreDisponibiliRound - tavolo.oreUsateRound };
}

function annullaAzione(tavolo, collaboratoreId, azioniConfig) {
  const azioneId = tavolo.azioniSottomesseRound[collaboratoreId];
  if (!azioneId) return { ok: true, oreResidue: tavolo.oreDisponibiliRound - tavolo.oreUsateRound };
  tavolo.oreUsateRound -= azioniConfig.azioni[azioneId].costoOre;
  delete tavolo.azioniSottomesseRound[collaboratoreId];
  return { ok: true, oreResidue: tavolo.oreDisponibiliRound - tavolo.oreUsateRound };
}

function chiudiRound(tavolo, roundNumero, azioniConfig, gameConfig, collaboratoriConfig, azioniSistemicheConfig, messaggiNarrativiConfig) {
  const coerenti = gameConfig.azioniCoerentiPerCluster;
  const climaDeltas = [];
  const messaggiNarrativi = [];
  const azioniAffiancamento = (messaggiNarrativiConfig && messaggiNarrativiConfig.azioniAffiancamento) || [];
  const faseDiQuestoRound = calcolaFase(roundNumero, gameConfig.fasi);

  // per l'impatto narrativo della crisi (Fase 3): quante richieste sono arrivate e quante gestite.
  let richiesteQuestoRound = 0;
  let richiesteGestiteQuestoRound = 0;

  for (const collaboratore of tavolo.collaboratori) {
    if (collaboratore.uscitoDallaRete) continue;

    const richiestaAttivaQuestoRound = !!collaboratore.richiestaCorrente;
    const richiestaTestoQuestoRound = richiestaAttivaQuestoRound ? collaboratore.richiestaCorrente.testo : null;
    const azioneId = tavolo.azioniSottomesseRound[collaboratore.id] || 'nessunIntervento';
    const azione = azioniConfig.azioni[azioneId];
    const effettiCluster = azione.effetti[collaboratore.cluster] || {};

    if (richiestaAttivaQuestoRound) {
      richiesteQuestoRound += 1;
      if (azioneId !== 'nessunIntervento') richiesteGestiteQuestoRound += 1;
    }

    // 1) applica effetti differiti in sospeso dal round precedente
    if (collaboratore.effettiDifferitiPendenti) {
      applicaEffetti(collaboratore.stats, collaboratore.effettiDifferitiPendenti);
      if (collaboratore.effettiDifferitiPendenti.climaTeam) {
        climaDeltas.push(collaboratore.effettiDifferitiPendenti.climaTeam);
      }
    }

    // 2) applica effetti immediati dell'azione di questo round
    applicaEffetti(collaboratore.stats, effettiCluster.immediato);
    if (effettiCluster.immediato && effettiCluster.immediato.climaTeam) {
      climaDeltas.push(effettiCluster.immediato.climaTeam);
    }

    // 3) accoda gli effetti differiti di questa azione per il prossimo round
    collaboratore.effettiDifferitiPendenti = effettiCluster.differito || {};

    // 4) penalita' extra per uso ripetuto di surroga
    if (azioneId === 'surroga') {
      collaboratore.usiConsecutiviSurroga += 1;
      const penal = azioniConfig.azioni.surroga.penalitaClimaSeUsoRipetuto;
      if (penal && collaboratore.usiConsecutiviSurroga >= penal.sogliaUsiConsecutivi) {
        climaDeltas.push(penal.climaTeam);
      }
    } else {
      collaboratore.usiConsecutiviSurroga = 0;
    }

    // 4b) tracciamento affiancamento consecutivo (serve al messaggio narrativo di dipendenza)
    if (azioniAffiancamento.includes(azioneId)) {
      collaboratore.usiConsecutiviAffiancamento += 1;
    } else {
      collaboratore.usiConsecutiviAffiancamento = 0;
    }

    // 5) tracciamento trascuratezza / rischio turnover
    const trascuratoPrimaDiQuestoRound = collaboratore.roundConsecutiviTrascurato;
    if (azioneId === 'nessunIntervento') {
      collaboratore.roundConsecutiviTrascurato += 1;
    } else {
      collaboratore.roundConsecutiviTrascurato = 0;
    }
    if (collaboratore.stats.motivazione < collaboratoriConfig.sogliaMotivazioneBassa) {
      collaboratore.roundConsecutiviMotivazioneBassa += 1;
    } else {
      collaboratore.roundConsecutiviMotivazioneBassa = Math.max(0, collaboratore.roundConsecutiviMotivazioneBassa - 1);
    }
    let deltaRischio = 0;
    if (collaboratore.roundConsecutiviMotivazioneBassa >= collaboratoriConfig.rondeConsecutiveMotivazioneBassaPerTurnover) {
      deltaRischio += 10;
    }
    if (collaboratore.roundConsecutiviTrascurato >= azioniConfig.rondeConsecutiveTrascuratoPerRischio) {
      deltaRischio += 10;
    }
    if (deltaRischio === 0) deltaRischio = -5;
    collaboratore.rischioTurnover = clamp(collaboratore.rischioTurnover + deltaRischio);

    // 5b) messaggi narrativi (dipendenza / abbandono) — regole generiche, non legate a nomi specifici
    if (messaggiNarrativiConfig) {
      const regolaDipendenza = messaggiNarrativiConfig.dipendenza;
      if (regolaDipendenza) {
        const cond = regolaDipendenza.condizioni;
        if (
          collaboratore.stats.competenza >= cond.competenzaMin &&
          collaboratore.stats.autonomia >= cond.autonomiaMin &&
          collaboratore.usiConsecutiviAffiancamento >= cond.usiConsecutiviAffiancamentoMin &&
          richiestaAttivaQuestoRound === cond.richiestaAttivaQuestoRound
        ) {
          messaggiNarrativi.push({
            tipo: 'dipendenza',
            collaboratoreId: collaboratore.id,
            testo: regolaDipendenza.template.replace('{nome}', collaboratore.nome)
          });
        }
      }

      const regolaAbbandono = messaggiNarrativiConfig.abbandono;
      if (regolaAbbandono) {
        const cond = regolaAbbandono.condizioni;
        const azioneNonNessunIntervento = azioneId !== 'nessunIntervento';
        if (
          trascuratoPrimaDiQuestoRound >= cond.roundConsecutiviTrascuratoMin &&
          azioneNonNessunIntervento === cond.azioneQuestoRoundDiversaDaNessunIntervento
        ) {
          messaggiNarrativi.push({
            tipo: 'abbandono',
            collaboratoreId: collaboratore.id,
            testo: regolaAbbandono.template.replace('{nome}', collaboratore.nome)
          });
          if (regolaAbbandono.effetto === 'escePotenzialmenteDallaRete') {
            collaboratore.uscitoDallaRete = true;
          }
        }
      }
    }

    collaboratore.richiestaCorrente = null;

    // 6) log e metriche
    tavolo.log.push({ round: roundNumero, collaboratoreId: collaboratore.id, azioneId, costoOre: azione.costoOre, cluster: collaboratore.cluster });
    tavolo.metriche.oreTotaliPerCollaboratore[collaboratore.id] = (tavolo.metriche.oreTotaliPerCollaboratore[collaboratore.id] || 0) + azione.costoOre;
    tavolo.metriche.oreTotali += azione.costoOre;
    tavolo.metriche.conteggioAzioni[azioneId] = (tavolo.metriche.conteggioAzioni[azioneId] || 0) + 1;
    tavolo.metriche.azioniTotaliCount += 1;
    if ((coerenti[collaboratore.cluster] || []).includes(azioneId)) {
      tavolo.metriche.azioniCoerentiCount += 1;
    }

    collaboratore.ultimaAzione = azioneId;

    // 7) storico stat (per le frecce di tendenza) e cronologia leggibile (per la scheda cliccabile)
    collaboratore.storicoStats.push({
      round: roundNumero,
      competenza: collaboratore.stats.competenza,
      autonomia: collaboratore.stats.autonomia,
      motivazione: collaboratore.stats.motivazione,
      resilienza: collaboratore.stats.resilienza,
      velocitaApprendimento: collaboratore.stats.velocitaApprendimento,
      risultati: collaboratore.stats.risultati
    });
    collaboratore.cronologia.push({
      round: roundNumero,
      richiesta: richiestaTestoQuestoRound,
      azioneId,
      azioneLabel: azione.label,
      costoOre: azione.costoOre,
      gestita: richiestaAttivaQuestoRound && azioneId !== 'nessunIntervento'
    });
  }

  // azioni sistemiche di Fase 4: agiscono sull'intera rete, non su un singolo collaboratore
  if (azioniSistemicheConfig && tavolo.azioniSistemicheSottomesseRound.length > 0) {
    for (const azioneSistemicaId of tavolo.azioniSistemicheSottomesseRound) {
      const azioneSistemica = azioniSistemicheConfig.azioniSistemiche[azioneSistemicaId];
      if (!azioneSistemica) continue;
      const costoAzioneSistemica = azioneSistemica.costoOre || 0;
      tavolo.metriche.oreTotali += costoAzioneSistemica;
      tavolo.metriche.oreSistemicheTotali += costoAzioneSistemica;
      tavolo.modificatorePropensioneSistemica -= Math.abs(azioneSistemica.effettoPropensioneRichiesta || 0);
      for (const c of tavolo.collaboratori) {
        if (c.uscitoDallaRete) continue;
        c.stats.autonomia = clamp(c.stats.autonomia + (azioneSistemica.effettoAutonomiaMedia || 0));
      }
      tavolo.azioniSistemicheLog.push({ round: roundNumero, azioneSistemicaId });
    }
    tavolo.azioniSistemicheSottomesseRound = [];
  }

  // Impatto narrativo della crisi: calcolato una sola volta, alla chiusura del round di Fase 3.
  if (faseDiQuestoRound === 3 && gameConfig.fasi.crisi) {
    const crisi = gameConfig.fasi.crisi;
    const nonGestite = richiesteQuestoRound - richiesteGestiteQuestoRound;
    let commento = crisi.commentoSeParzialiGestite || '';
    if (richiesteQuestoRound === 0 || nonGestite === 0) commento = crisi.commentoSeTutteGestite || '';
    else if (richiesteGestiteQuestoRound === 0) commento = crisi.commentoSeNessunaGestita || '';
    const testo = (crisi.testoImpattoTemplate || '')
      .replace('{richieste}', richiesteQuestoRound)
      .replace('{gestite}', richiesteGestiteQuestoRound)
      .replace('{nonGestite}', nonGestite)
      .replace('{commento}', commento);
    tavolo.impattoCrisi = {
      round: roundNumero,
      richieste: richiesteQuestoRound,
      gestite: richiesteGestiteQuestoRound,
      nonGestite,
      testo
    };
  }

  // Messaggio narrativo di Fase 4: quando le richieste al manager scendono in modo significativo
  // rispetto alla Fase 2, grazie alle azioni sistemiche gia' attivate (mostrato una sola volta a sessione).
  if (
    faseDiQuestoRound === 4 &&
    gameConfig.fase4 &&
    !tavolo.messaggioCaloRichiesteMostrato &&
    tavolo.azioniSistemicheLog.length > 0
  ) {
    const richiesteFase2 = tavolo.storicoRichieste.filter((r) => r.round <= gameConfig.fasi.numeroRoundFase2);
    const mediaFase2 = media(richiesteFase2.map((r) => r.numeroRichieste));
    const ultimoStorico = tavolo.storicoRichieste[tavolo.storicoRichieste.length - 1];
    if (mediaFase2 > 0 && ultimoStorico && ultimoStorico.round === roundNumero) {
      const caloPercentuale = ((mediaFase2 - ultimoStorico.numeroRichieste) / mediaFase2) * 100;
      if (caloPercentuale >= gameConfig.fase4.caloRichiesteSogliaPercentuale) {
        messaggiNarrativi.push({ tipo: 'sistemaMaturo', testo: gameConfig.fase4.messaggioCaloRichieste });
        tavolo.messaggioCaloRichiesteMostrato = true;
      }
    }
  }

  tavolo.messaggiNarrativiRound = messaggiNarrativi;

  // clima team: media motivazione+fiducia + delta eventi
  const mediaMotivFiducia =
    tavolo.collaboratori.reduce((s, c) => s + (c.stats.motivazione + c.stats.fiducia) / 2, 0) / tavolo.collaboratori.length;
  const sommaClimaDeltas = climaDeltas.reduce((a, b) => a + b, 0);
  tavolo.climaTeam = clamp(0.7 * tavolo.climaTeam + 0.3 * mediaMotivFiducia + sommaClimaDeltas);

  // registra allocazione ore di questo round per calcolo reattivita'
  const allocazioneRound = {};
  for (const c of tavolo.collaboratori) {
    const azioneId = tavolo.azioniSottomesseRound[c.id] || 'nessunIntervento';
    allocazioneRound[c.id] = azioniConfig.azioni[azioneId].costoOre;
  }
  tavolo.metriche.allocazionePerRound.push(allocazioneRound);

  // punteggio del round (per grafici debrief)
  const performanceRete = media(tavolo.collaboratori.map((c) => c.stats.risultati));
  const autonomiaMedia = media(tavolo.collaboratori.map((c) => c.stats.autonomia));
  const motivazioneMedia = media(tavolo.collaboratori.map((c) => c.stats.motivazione));
  const rischioMedio = media(tavolo.collaboratori.map((c) => c.rischioTurnover));

  tavolo.punteggiPerRound.push({
    round: roundNumero,
    performanceRete: Math.round(performanceRete),
    autonomiaMedia: Math.round(autonomiaMedia),
    motivazioneMedia: Math.round(motivazioneMedia),
    climaTeam: Math.round(tavolo.climaTeam),
    rischioTurnoverMedio: Math.round(rischioMedio),
    oreUsate: tavolo.oreUsateRound
  });

  // reset per il round successivo
  tavolo.azioniSottomesseRound = {};
  tavolo.oreUsateRound = 0;
  tavolo.confermato = false;
}

function media(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// Freccia di tendenza per una stat: confronta l'ultima rilevazione con la media mobile delle
// (fino a) tre rilevazioni precedenti. Restituisce null finche' non c'e' abbastanza storia
// (prima settimana giocata), altrimenti 'su' / 'giu' / 'stabile'. Una piccola soglia evita che
// oscillazioni di 1 punto facciano lampeggiare la freccia senza un vero cambiamento percepibile.
function calcolaTrend(storicoStats, campo) {
  if (!storicoStats || storicoStats.length < 2) return null;
  const ultimo = storicoStats[storicoStats.length - 1][campo];
  const precedenti = storicoStats.slice(-4, -1); // fino a 3 rilevazioni prima dell'ultima
  if (precedenti.length === 0) return null;
  const mediaPrecedenti = precedenti.reduce((acc, s) => acc + s[campo], 0) / precedenti.length;
  const soglia = 1.5;
  if (ultimo > mediaPrecedenti + soglia) return 'su';
  if (ultimo < mediaPrecedenti - soglia) return 'giu';
  return 'stabile';
}

// Indicatore complessivo a stelle (1-5): media di tutte le stat visibili ai partecipanti,
// tradotta in fasce da 20 punti. Va da 1 a 5 stelle, mai 0 (anche un valore basso resta leggibile
// come "1 stella" invece di sparire).
function calcolaStelle(stats, campiVisibili) {
  const valori = campiVisibili.filter((c) => c !== 'nome' && stats[c] !== undefined).map((c) => stats[c]);
  if (!valori.length) return 3;
  const mediaValori = valori.reduce((a, b) => a + b, 0) / valori.length;
  return Math.max(1, Math.min(5, Math.round(mediaValori / 20)));
}

function calcolaClassificaFinale(tavoli, gameConfig) {
  const pesi = gameConfig.pesiClassifica;
  const righe = Object.values(tavoli).map((tavolo) => {
    const ultimo = tavolo.punteggiPerRound[tavolo.punteggiPerRound.length - 1] || {};
    const performanceRete = ultimo.performanceRete || 0;

    const crescita = media(
      tavolo.collaboratori.map((c) => (c.stats.competenza - c.statsIniziali.competenza) + (c.stats.autonomia - c.statsIniziali.autonomia))
    );
    const crescitaNormalizzata = clamp(50 + crescita, 0, 100);

    const oreTotaliDisponibili = tavolo.punteggiPerRound.length * gameConfig.oreManagerialiPerRound;
    const efficienzaTempo = oreTotaliDisponibili > 0
      ? clamp((performanceRete / 100) * (1 - (tavolo.metriche.oreTotali / (oreTotaliDisponibili * 1.4))) * 100)
      : 0;

    const autonomiaSquadra = ultimo.autonomiaMedia || 0;
    const clima = ultimo.climaTeam || 0;

    const rischioFinale = ultimo.rischioTurnoverMedio || 0;
    const sostenibilita = rischioFinale > gameConfig.sogliaTurnoverRischioFinale
      ? clamp(100 - rischioFinale - gameConfig.penalitaSostenibilitaPerTurnoverAlto)
      : clamp(100 - rischioFinale);

    const punteggioTotale =
      performanceRete * pesi.performanceRete +
      crescitaNormalizzata * pesi.crescitaCollaboratori +
      efficienzaTempo * pesi.efficienzaTempo +
      autonomiaSquadra * pesi.autonomiaSquadra +
      clima * pesi.clima +
      sostenibilita * pesi.sostenibilita;

    return {
      tavoloId: tavolo.id,
      nome: tavolo.nome,
      performanceRete: Math.round(performanceRete),
      crescitaCollaboratori: Math.round(crescitaNormalizzata),
      efficienzaTempo: Math.round(efficienzaTempo),
      autonomiaSquadra: Math.round(autonomiaSquadra),
      clima: Math.round(clima),
      sostenibilita: Math.round(sostenibilita),
      punteggioTotale: Math.round(punteggioTotale * 100) / 100
    };
  });

  righe.sort((a, b) => b.punteggioTotale - a.punteggioTotale);
  righe.forEach((r, i) => (r.posizione = i + 1));
  return righe;
}

// Calcola l'epilogo narrativo di fine sessione ("una settimana senza di voi") per un tavolo,
// scegliendo il primo scenario (in ordine di config) le cui condizioni sono soddisfatte dalle
// metriche finali. Ogni condizione e' opzionale: se assente, non viene valutata (sempre vera).
function calcolaEpilogo(tavolo, epilogoConfig) {
  if (!epilogoConfig || !Array.isArray(epilogoConfig.scenari)) return null;

  const ultimo = tavolo.punteggiPerRound[tavolo.punteggiPerRound.length - 1] || {};
  const autonomiaMedia = ultimo.autonomiaMedia || 0;
  const rischioTurnoverMedio = ultimo.rischioTurnoverMedio || 0;
  const usciti = tavolo.collaboratori.filter((c) => c.uscitoDallaRete);

  const contesto = {
    numUsciti: usciti.length,
    nomiUsciti: usciti.map((c) => c.nome).join(', ') || 'nessuno'
  };

  for (const scenario of epilogoConfig.scenari) {
    const cond = scenario.condizioni || {};
    if (cond.usciriDallaReteMin !== undefined && usciti.length < cond.usciriDallaReteMin) continue;
    if (cond.autonomiaMediaMin !== undefined && autonomiaMedia < cond.autonomiaMediaMin) continue;
    if (cond.autonomiaMediaMax !== undefined && autonomiaMedia > cond.autonomiaMediaMax) continue;
    if (cond.rischioTurnoverMedioMin !== undefined && rischioTurnoverMedio < cond.rischioTurnoverMedioMin) continue;
    if (cond.rischioTurnoverMedioMax !== undefined && rischioTurnoverMedio > cond.rischioTurnoverMedioMax) continue;

    let testo = scenario.template;
    for (const [chiave, valore] of Object.entries(contesto)) {
      testo = testo.replace(`{${chiave}}`, valore);
    }
    return { id: scenario.id, titolo: scenario.titolo, testo };
  }

  return null;
}

module.exports = {
  clamp,
  media,
  nuovoTavolo,
  applicaAzione,
  annullaAzione,
  chiudiRound,
  calcolaClassificaFinale,
  assegnaCategoria,
  calcolaFase,
  numeroRoundTotali,
  generaRichiesteRound,
  applicaAzioneSistemica,
  seedDaStringa,
  creaGeneratoreSeeded,
  calcolaEpilogo,
  calcolaTrend,
  calcolaStelle
};
