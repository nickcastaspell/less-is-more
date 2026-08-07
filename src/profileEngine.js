'use strict';

/**
 * Calcola il profilo manageriale finale confrontando le metriche di un
 * tavolo (derivate dal log completo delle decisioni) con i vettori-
 * segnatura definiti in config/profili.json. Nessun giudizio di valore:
 * e' semplicemente il profilo con distanza minima.
 */

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function calcolaMetriche(tavolo, gameConfig) {
  const { oreTotali, oreTotaliPerCollaboratore, conteggioAzioni, azioniCoerentiCount, azioniTotaliCount, allocazionePerRound } = tavolo.metriche;

  const oreDaCluster = { performer: 0, potenziale: 0, resistente: 0 };
  let oreShadowingSuPerformer = 0;

  for (const voce of tavolo.log) {
    // costoOre nel log e' il costo dell'azione scelta per quel collaboratore in quel round
    const collaboratore = tavolo.collaboratori.find((c) => c.id === voce.collaboratoreId);
    const cluster = collaboratore ? collaboratore.cluster : voce.cluster;
    oreDaCluster[cluster] = (oreDaCluster[cluster] || 0) + voce.costoOre;
    if (voce.azioneId === 'shadowing' && cluster === 'performer') {
      oreShadowingSuPerformer += voce.costoOre;
    }
  }

  const totaleOre = oreTotali || 1;
  const focusPotenziale = clamp01(oreDaCluster.potenziale / totaleOre);
  const focusPerformer = clamp01(oreDaCluster.performer / totaleOre);
  const focusResistente = clamp01(oreDaCluster.resistente / totaleOre);

  const totaleAzioni = azioniTotaliCount || 1;
  // Separate: "delega" e' una scelta attiva di responsabilizzazione, "nessunIntervento" e' assenza
  // di azione. Confonderle nella stessa metrica appiattiva profili molto diversi (es. Coltivatore
  // che delega consapevolmente vs. Accentratore/Salvatore che trascura).
  const quotaDelega = clamp01((conteggioAzioni.delega || 0) / totaleAzioni);
  const quotaNessunIntervento = clamp01((conteggioAzioni.nessunIntervento || 0) / totaleAzioni);
  const quotaSurroga = clamp01((conteggioAzioni.surroga || 0) / totaleAzioni);
  const coerenzaSituazionale = clamp01(azioniCoerentiCount / totaleAzioni);
  const quotaShadowingSuPerformer = clamp01(oreShadowingSuPerformer / totaleOre);

  // concentrazione ore (HHI normalizzato sul numero di collaboratori)
  const n = tavolo.collaboratori.length || 1;
  const quote = Object.values(oreTotaliPerCollaboratore).map((ore) => ore / totaleOre);
  const hhi = quote.reduce((s, q) => s + q * q, 0);
  const hhiMin = 1 / n;
  const concentrazioneOre = clamp01((hhi - hhiMin) / (1 - hhiMin || 1));

  // reattivita': variazione media dell'allocazione ore per collaboratore tra round consecutivi
  let reattivita = 0;
  if (allocazionePerRound.length > 1) {
    let sommaDiff = 0;
    let conteggio = 0;
    for (let i = 1; i < allocazionePerRound.length; i++) {
      const prev = allocazionePerRound[i - 1];
      const curr = allocazionePerRound[i];
      for (const collabId of Object.keys(curr)) {
        sommaDiff += Math.abs((curr[collabId] || 0) - (prev[collabId] || 0));
        conteggio += 1;
      }
    }
    const diffMedia = conteggio > 0 ? sommaDiff / conteggio : 0;
    reattivita = clamp01(diffMedia / 4); // 4 = costo ore massimo di una singola azione
  }

  const numeroRoundGiocati = tavolo.punteggiPerRound.length || 1;
  const quotaOreUsateSulDisponibile = clamp01(totaleOre / (numeroRoundGiocati * gameConfig.oreManagerialiPerRound));

  return {
    focusPotenziale,
    focusPerformer,
    focusResistente,
    quotaDelega,
    quotaNessunIntervento,
    quotaSurroga,
    concentrazioneOre,
    coerenzaSituazionale,
    reattivita,
    quotaShadowingSuPerformer,
    quotaOreUsateSulDisponibile
  };
}

function distanzaPesata(vettoreA, vettoreB, pesi) {
  let somma = 0;
  for (let i = 0; i < vettoreA.length; i++) {
    const d = vettoreA[i] - vettoreB[i];
    somma += pesi[i] * d * d;
  }
  return Math.sqrt(somma);
}

function calcolaProfilo(tavolo, profiliConfig, gameConfig) {
  const metriche = calcolaMetriche(tavolo, gameConfig);
  const ordine = profiliConfig.metricheOrdine;
  const pesi = profiliConfig.pesiMetriche;
  const vettoreTavolo = ordine.map((chiave) => metriche[chiave]);

  const distanze = Object.entries(profiliConfig.profili).map(([chiave, def]) => ({
    chiave,
    label: def.label,
    descrizione: def.descrizione,
    distanza: distanzaPesata(vettoreTavolo, def.vettore, pesi)
  }));

  distanze.sort((a, b) => a.distanza - b.distanza);

  return {
    metriche,
    profiloPrincipale: distanze[0],
    tendenzaSecondaria: distanze[1],
    tutteLeDistanze: distanze
  };
}

module.exports = { calcolaMetriche, calcolaProfilo };
