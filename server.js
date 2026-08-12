'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const QRCode = require('qrcode');
const { Server } = require('socket.io');

const sessionManager = require('./src/sessionManager');
const gameEngine = require('./src/gameEngine');
const profileEngine = require('./src/profileEngine');

const collaboratoriConfig = require('./config/collaboratori.json');
const azioniConfig = require('./config/azioni.json');
const azioniSistemicheConfig = require('./config/azioniSistemiche.json');
const profiliConfig = require('./config/profili.json');
const gameConfigDefault = require('./config/gameConfig.json');
const messaggiNarrativiConfig = require('./config/messaggiNarrativi.json');
const epilogoConfig = require('./config/epilogo.json');

const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use('/facilitatore', express.static(path.join(__dirname, 'public', 'facilitator')));
app.use('/tavolo', express.static(path.join(__dirname, 'public', 'team')));
app.use('/shared', express.static(path.join(__dirname, 'public', 'shared')));

app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html><html lang="it"><head><meta charset="UTF-8"><title>Less is More</title>
  <style>body{font-family:system-ui,sans-serif;background:#0b1220;color:#eef1f6;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
  a{display:inline-block;margin:10px;padding:14px 28px;background:#d9b45c;color:#0b1220;text-decoration:none;border-radius:8px;font-weight:600}
  .box{text-align:center}</style></head><body><div class="box">
  <h1>LESS IS MORE</h1>
  <p>Business game — Leadership Through Smart Resource Allocation</p>
  <a href="/facilitatore/">Regia facilitatore</a>
  <a href="/tavolo/">Accesso tavolo</a>
  </div></body></html>`);
});

// ---------- Helpers ----------

function baseUrl(req) {
  return process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
}

// Determina la fase corrente (1-4) di una sessione. La Fase 1 e' uno stato a se',
// dalla Fase 2 in poi la fase si deduce dal round corrente.
function faseDellaSessione(sessione) {
  if (sessione.stato === 'fase1_classificazione') return 1;
  return gameEngine.calcolaFase(sessione.roundCorrente, sessione.gameConfig.fasi);
}

// Le tre stat mostrate come barre con freccia di tendenza sulla scheda collaboratore (vedi
// team.js/renderCollaboratori). La Resilienza e' stata esclusa di proposito: e' un tratto
// stabile del personaggio che il motore non fa mai variare, quindi una freccia su di lei
// sarebbe sempre "piatta" — Competenza la sostituisce perche' si muove davvero round su round.
const CAMPI_BARRA_TENDENZA = ['autonomia', 'motivazione', 'competenza'];

function filtraCollaboratorePerTeam(collaboratore) {
  const statsVisibili = {};
  for (const campo of collaboratoriConfig.campiVisibiliAiPartecipanti) {
    if (campo === 'nome') continue;
    if (collaboratore.stats[campo] !== undefined) statsVisibili[campo] = collaboratore.stats[campo];
  }
  const trend = {};
  CAMPI_BARRA_TENDENZA.forEach((campo) => {
    trend[campo] = gameEngine.calcolaTrend(collaboratore.storicoStats, campo);
  });
  return {
    id: collaboratore.id,
    nome: collaboratore.nome,
    stats: statsVisibili,
    stelle: gameEngine.calcolaStelle(collaboratore.stats, collaboratoriConfig.campiVisibiliAiPartecipanti),
    trend,
    cronologia: collaboratore.cronologia,
    ultimaAzione: collaboratore.ultimaAzione,
    categoriaAssegnata: collaboratore.categoriaAssegnata,
    richiestaCorrente: collaboratore.richiestaCorrente,
    uscitoDallaRete: collaboratore.uscitoDallaRete
  };
}

function vistaTavoloPerTeam(tavolo, sessione) {
  return {
    id: tavolo.id,
    nome: tavolo.nome,
    oreDisponibiliRound: tavolo.oreDisponibiliRound,
    oreUsateRound: tavolo.oreUsateRound,
    azioniSottomesseRound: tavolo.azioniSottomesseRound,
    azioniSistemicheSottomesseRound: tavolo.azioniSistemicheSottomesseRound,
    climaTeam: Math.round(tavolo.climaTeam),
    collaboratori: tavolo.collaboratori.map(filtraCollaboratorePerTeam),
    confermato: tavolo.confermato,
    storicoPunteggi: tavolo.punteggiPerRound,
    storicoRichieste: tavolo.storicoRichieste,
    messaggiNarrativiRound: tavolo.messaggiNarrativiRound,
    impattoCrisi: tavolo.impattoCrisi,
    statoSessione: sessione.stato,
    roundCorrente: sessione.roundCorrente,
    numeroRound: sessione.numeroRound,
    faseCorrente: faseDellaSessione(sessione),
    inPausa: !!sessione.inPausa,
    roundIniziatoIl: sessione.roundIniziatoIl || null,
    durataRoundSecondi: sessione.durataRoundSecondi || null
  };
}

function vistaTavoloPerFacilitatore(tavolo) {
  return {
    id: tavolo.id,
    nome: tavolo.nome,
    codiceAccesso: tavolo.codiceAccesso,
    oreDisponibiliRound: tavolo.oreDisponibiliRound,
    oreUsateRound: tavolo.oreUsateRound,
    confermato: tavolo.confermato,
    climaTeam: Math.round(tavolo.climaTeam),
    collaboratori: tavolo.collaboratori.map((c) => ({
      id: c.id,
      nome: c.nome,
      cluster: c.cluster,
      stats: c.stats,
      rischioTurnover: c.rischioTurnover,
      roundConsecutiviTrascurato: c.roundConsecutiviTrascurato,
      categoriaAssegnata: c.categoriaAssegnata,
      richiestaCorrente: c.richiestaCorrente,
      uscitoDallaRete: c.uscitoDallaRete
    })),
    storicoPunteggi: tavolo.punteggiPerRound,
    storicoRichieste: tavolo.storicoRichieste,
    messaggiNarrativiRound: tavolo.messaggiNarrativiRound,
    impattoCrisi: tavolo.impattoCrisi,
    azioniSistemicheLog: tavolo.azioniSistemicheLog,
    log: tavolo.log
  };
}

function vistaSessionePerFacilitatore(sessione) {
  return {
    id: sessione.id,
    nome: sessione.nome,
    stato: sessione.stato,
    roundCorrente: sessione.roundCorrente,
    numeroRound: sessione.numeroRound,
    faseCorrente: faseDellaSessione(sessione),
    gameConfig: sessione.gameConfig,
    inPausa: !!sessione.inPausa,
    roundIniziatoIl: sessione.roundIniziatoIl || null,
    durataRoundSecondi: sessione.durataRoundSecondi || null,
    tavoli: Object.values(sessione.tavoli).map(vistaTavoloPerFacilitatore)
  };
}

// Pacchetti "completi" (usati sia al join sia nei broadcast) cosi' un client che si
// (ri)connette a sessione gia' terminata riceve subito anche i risultati finali.
function pacchettoStatoFacilitatore(sessione) {
  const base = vistaSessionePerFacilitatore(sessione);
  if (sessione.stato === 'terminata' && sessione.risultatiFinali) {
    base.risultatiFinali = sessione.risultatiFinali;
  }
  return base;
}

function pacchettoStatoTeam(tavolo, sessione) {
  const base = vistaTavoloPerTeam(tavolo, sessione);
  if (sessione.stato === 'terminata' && sessione.risultatiFinali) {
    base.risultatoFinale = sessione.risultatiFinali.classifica.find((r) => r.tavoloId === tavolo.id);
    base.profilo = sessione.risultatiFinali.profili[tavolo.id];
    base.epilogo = sessione.risultatiFinali.epiloghi && sessione.risultatiFinali.epiloghi[tavolo.id];
  }
  return base;
}

// ---------- REST API ----------

// Verifica il token di regia (query string ?tok=...) per le rotte che espongono lo stato
// completo di una sessione (dati di tutti i tavoli). Il token e' rivelato una sola volta,
// nella risposta di POST /api/sessioni, a chi ha creato la sessione.
function richiedeTokenFacilitatore(req, res, sessione) {
  const tok = req.query.tok;
  if (!tok || tok !== sessione.tokenFacilitatore) {
    res.status(403).json({ errore: 'token facilitatore mancante o non valido' });
    return false;
  }
  return true;
}

app.post('/api/sessioni', (req, res) => {
  const { nome, numeroTavoli, nomiTavoli, oreManagerialiPerRound, numeroRoundFase2, numeroRoundFase4 } = req.body;
  if (!numeroTavoli || numeroTavoli < 1) {
    return res.status(400).json({ errore: 'numeroTavoli deve essere >= 1' });
  }
  const gameConfig = {
    ...gameConfigDefault,
    oreManagerialiPerRound: oreManagerialiPerRound || gameConfigDefault.oreManagerialiPerRound,
    fasi: {
      ...gameConfigDefault.fasi,
      numeroRoundFase2: numeroRoundFase2 || gameConfigDefault.fasi.numeroRoundFase2,
      numeroRoundFase4: numeroRoundFase4 || gameConfigDefault.fasi.numeroRoundFase4
    }
  };
  const sessione = sessionManager.creaSessione({ nome, numeroTavoli, nomiTavoli, gameConfig, collaboratoriConfig });
  // Il token di regia viene rivelato solo qui, a chi ha appena creato la sessione: va
  // conservato lato client (facilitator.js lo salva in localStorage) per riaprire la regia.
  res.json({ ...vistaSessionePerFacilitatore(sessione), tokenFacilitatore: sessione.tokenFacilitatore });
});

app.get('/api/sessioni', (req, res) => {
  res.json(sessionManager.elencoSessioni());
});

app.get('/api/sessioni/:id', (req, res) => {
  const sessione = sessionManager.getSessione(req.params.id);
  if (!sessione) return res.status(404).json({ errore: 'sessione non trovata' });
  if (!richiedeTokenFacilitatore(req, res, sessione)) return;
  res.json(pacchettoStatoFacilitatore(sessione));
});

// Elimina definitivamente una sessione (usato dal pulsante "Elimina" nella lista delle
// sessioni salvate in home facilitatore). Richiede il token facilitatore, cosi' come le
// altre operazioni sensibili sulla sessione.
app.delete('/api/sessioni/:id', (req, res) => {
  const sessione = sessionManager.getSessione(req.params.id);
  if (!sessione) return res.status(404).json({ errore: 'sessione non trovata' });
  if (!richiedeTokenFacilitatore(req, res, sessione)) return;
  sessionManager.eliminaSessione(req.params.id);
  res.json({ ok: true });
});

app.get('/api/sessioni/:id/tavoli/:tavoloId/link', async (req, res) => {
  const sessione = sessionManager.getSessione(req.params.id);
  if (!sessione) return res.status(404).json({ errore: 'sessione non trovata' });
  if (!richiedeTokenFacilitatore(req, res, sessione)) return;
  const tavolo = sessione.tavoli[req.params.tavoloId];
  if (!tavolo) return res.status(404).json({ errore: 'tavolo non trovato' });

  const url = `${baseUrl(req)}/tavolo/?s=${sessione.id}&t=${tavolo.id}&tok=${tavolo.token}`;
  const qrDataUrl = await QRCode.toDataURL(url, { margin: 1, width: 300 });
  res.json({ url, codiceAccesso: tavolo.codiceAccesso, qrDataUrl, token: tavolo.token });
});

app.post('/api/sessioni/:id/resolve-codice', (req, res) => {
  const sessione = sessionManager.getSessione(req.params.id);
  if (!sessione) return res.status(404).json({ errore: 'sessione non trovata' });
  const { codice } = req.body;
  const tavolo = Object.values(sessione.tavoli).find((t) => t.codiceAccesso === (codice || '').toUpperCase());
  if (!tavolo) return res.status(404).json({ errore: 'codice non valido' });
  // Conoscere il codice d'accesso e' la credenziale: risolverlo restituisce anche il token
  // del tavolo, necessario per il successivo tavolo:join via socket.
  res.json({ tavoloId: tavolo.id, token: tavolo.token });
});

app.post('/api/sessioni/:id/backup', (req, res) => {
  const sessione = sessionManager.getSessione(req.params.id);
  if (!sessione) return res.status(404).json({ errore: 'sessione non trovata' });
  if (!richiedeTokenFacilitatore(req, res, sessione)) return;
  const backup = sessionManager.creaBackup(sessione.id);
  res.json({ ok: true, backup });
});

app.get('/api/sessioni/:id/backup', (req, res) => {
  const sessione = sessionManager.getSessione(req.params.id);
  if (!sessione) return res.status(404).json({ errore: 'sessione non trovata' });
  if (!richiedeTokenFacilitatore(req, res, sessione)) return;
  res.json({ backups: sessionManager.elencoBackup(sessione.id) });
});

app.post('/api/sessioni/:id/restore', (req, res) => {
  const sessione = sessionManager.getSessione(req.params.id);
  if (!sessione) return res.status(404).json({ errore: 'sessione non trovata' });
  if (!richiedeTokenFacilitatore(req, res, sessione)) return;
  const { backupId } = req.body;
  if (!backupId) return res.status(400).json({ errore: 'backupId mancante' });
  const risultato = sessionManager.ripristinaBackup(sessione.id, backupId);
  if (!risultato.ok) return res.status(400).json({ errore: risultato.motivo });
  broadcastStatoCompleto(sessione.id);
  res.json({ ok: true });
});

app.get('/config/pubblico', (req, res) => {
  res.json({
    azioni: azioniConfig.azioni,
    azioniSistemiche: azioniSistemicheConfig.azioniSistemiche,
    eventiFacilitatore: gameConfigDefault.eventiFacilitatore,
    categorieClassificazione: collaboratoriConfig.categorieClassificazione,
    fasi: gameConfigDefault.fasi
  });
});

// ---------- Socket.io ----------

io.on('connection', (socket) => {
  // Ogni socket, una volta unito a una sessione/tavolo, "ricorda" il proprio ruolo e la
  // propria identita' in socket.data (stato lato server, non manipolabile dal client). Tutti
  // gli handler successivi usano socket.data invece di fidarsi di sessionId/tavoloId inviati
  // nel payload dell'evento, per evitare che un client possa impersonare un altro tavolo o
  // un'altra sessione semplicemente cambiando i valori inviati.
  socket.on('facilitatore:join', ({ sessionId, tok }) => {
    const sessione = sessionManager.getSessione(sessionId);
    if (!sessione) return socket.emit('errore', { messaggio: 'sessione non trovata' });
    if (!tok || tok !== sessione.tokenFacilitatore) {
      return socket.emit('errore', { messaggio: 'token facilitatore mancante o non valido' });
    }
    socket.join(`facilitatore:${sessionId}`);
    socket.data.ruolo = 'facilitatore';
    socket.data.sessionId = sessionId;
    socket.emit('facilitatore:stato', pacchettoStatoFacilitatore(sessione));
  });

  socket.on('tavolo:join', ({ sessionId, tavoloId, tok }) => {
    const sessione = sessionManager.getSessione(sessionId);
    if (!sessione) return socket.emit('errore', { messaggio: 'sessione non trovata' });
    const tavolo = sessione.tavoli[tavoloId];
    if (!tavolo) return socket.emit('errore', { messaggio: 'tavolo non trovato' });
    if (!tok || tok !== tavolo.token) {
      return socket.emit('errore', { messaggio: 'token tavolo mancante o non valido' });
    }
    socket.join(`tavolo:${sessionId}:${tavoloId}`);
    socket.data.ruolo = 'tavolo';
    socket.data.sessionId = sessionId;
    socket.data.tavoloId = tavoloId;
    socket.emit('tavolo:stato', pacchettoStatoTeam(tavolo, sessione));
  });

  // Recupera sessione+tavolo del socket chiamante in base al join gia' effettuato,
  // ignorando qualunque sessionId/tavoloId eventualmente presente nel payload dell'evento.
  function tavoloDelSocket() {
    if (socket.data.ruolo !== 'tavolo' || !socket.data.sessionId || !socket.data.tavoloId) return null;
    const sessione = sessionManager.getSessione(socket.data.sessionId);
    if (!sessione) return null;
    const tavolo = sessione.tavoli[socket.data.tavoloId];
    if (!tavolo) return null;
    return { sessione, tavolo, sessionId: socket.data.sessionId, tavoloId: socket.data.tavoloId };
  }

  function sessioneDelFacilitatore() {
    if (socket.data.ruolo !== 'facilitatore' || !socket.data.sessionId) return null;
    const sessione = sessionManager.getSessione(socket.data.sessionId);
    if (!sessione) return null;
    return { sessione, sessionId: socket.data.sessionId };
  }

  // Guardia comune per gli handler che modificano le scelte di un tavolo: rifiuta l'azione
  // se la sessione e' in pausa (il facilitatore l'ha congelata temporaneamente) o se il tavolo
  // ha gia' confermato le proprie scelte per questo round (lock server-side, non solo cosmetico).
  function verificaTavoloModificabile(sessione, tavolo, socket) {
    if (sessione.inPausa) {
      socket.emit('tavolo:erroreAzione', { messaggio: 'La sessione e\' in pausa: attendi che il facilitatore riprenda.' });
      return false;
    }
    if (tavolo.confermato) {
      socket.emit('tavolo:erroreAzione', { messaggio: 'Le scelte di questo round sono confermate e bloccate. Sblocca per modificarle.' });
      return false;
    }
    return true;
  }

  socket.on('tavolo:classificaCollaboratore', ({ collaboratoreId, categoria }) => {
    const ctx = tavoloDelSocket();
    if (!ctx) return;
    const { sessione, tavolo, sessionId, tavoloId } = ctx;
    if (sessione.inPausa) return;
    gameEngine.assegnaCategoria(tavolo, collaboratoreId, categoria, sessione.roundCorrente);
    sessionManager.salvaSuDisco();
    io.to(`tavolo:${sessionId}:${tavoloId}`).emit('tavolo:stato', pacchettoStatoTeam(tavolo, sessione));
    io.to(`facilitatore:${sessionId}`).emit('facilitatore:stato', pacchettoStatoFacilitatore(sessione));
  });

  socket.on('tavolo:submitAzioneSistemica', ({ azioneSistemicaId }) => {
    const ctx = tavoloDelSocket();
    if (!ctx) return;
    const { sessione, tavolo, sessionId, tavoloId } = ctx;
    if (sessione.stato !== 'in_round') {
      return socket.emit('tavolo:erroreAzione', { messaggio: 'round non attivo' });
    }
    if (!verificaTavoloModificabile(sessione, tavolo, socket)) return;
    const risultato = gameEngine.applicaAzioneSistemica(tavolo, azioneSistemicaId, azioniSistemicheConfig);
    if (!risultato.ok) {
      return socket.emit('tavolo:erroreAzione', { messaggio: 'ore manageriali insufficienti', oreResidue: risultato.oreResidue });
    }
    sessionManager.salvaSuDisco();
    io.to(`tavolo:${sessionId}:${tavoloId}`).emit('tavolo:stato', vistaTavoloPerTeam(tavolo, sessione));
    io.to(`facilitatore:${sessionId}`).emit('facilitatore:stato', vistaSessionePerFacilitatore(sessione));
  });

  socket.on('tavolo:submitAzione', ({ collaboratoreId, azioneId }) => {
    const ctx = tavoloDelSocket();
    if (!ctx) return;
    const { sessione, tavolo, sessionId, tavoloId } = ctx;
    if (sessione.stato !== 'in_round') {
      return socket.emit('tavolo:erroreAzione', { messaggio: 'round non attivo' });
    }
    if (!verificaTavoloModificabile(sessione, tavolo, socket)) return;
    const risultato = gameEngine.applicaAzione(tavolo, collaboratoreId, azioneId, azioniConfig);
    if (!risultato.ok) {
      return socket.emit('tavolo:erroreAzione', { messaggio: 'ore manageriali insufficienti', oreResidue: risultato.oreResidue });
    }
    sessionManager.salvaSuDisco();
    io.to(`tavolo:${sessionId}:${tavoloId}`).emit('tavolo:stato', vistaTavoloPerTeam(tavolo, sessione));
    io.to(`facilitatore:${sessionId}`).emit('facilitatore:stato', vistaSessionePerFacilitatore(sessione));
  });

  socket.on('tavolo:annullaAzione', ({ collaboratoreId }) => {
    const ctx = tavoloDelSocket();
    if (!ctx) return;
    const { sessione, tavolo, sessionId, tavoloId } = ctx;
    if (sessione.stato !== 'in_round') return;
    if (!verificaTavoloModificabile(sessione, tavolo, socket)) return;
    gameEngine.annullaAzione(tavolo, collaboratoreId, azioniConfig);
    sessionManager.salvaSuDisco();
    io.to(`tavolo:${sessionId}:${tavoloId}`).emit('tavolo:stato', vistaTavoloPerTeam(tavolo, sessione));
    io.to(`facilitatore:${sessionId}`).emit('facilitatore:stato', vistaSessionePerFacilitatore(sessione));
  });

  socket.on('tavolo:confermaRound', () => {
    const ctx = tavoloDelSocket();
    if (!ctx) return;
    const { sessione, tavolo, sessionId, tavoloId } = ctx;
    if (sessione.inPausa) return socket.emit('tavolo:erroreAzione', { messaggio: 'La sessione e\' in pausa.' });
    tavolo.confermato = true;
    sessionManager.salvaSuDisco();
    io.to(`tavolo:${sessionId}:${tavoloId}`).emit('tavolo:stato', vistaTavoloPerTeam(tavolo, sessione));
    io.to(`facilitatore:${sessionId}`).emit('facilitatore:stato', vistaSessionePerFacilitatore(sessione));
  });

  // Sblocco delle scelte confermate: il tavolo stesso puo' sempre tornare sulle proprie scelte
  // (es. per correggere un errore), il facilitatore puo' sbloccare un tavolo specifico da regia.
  socket.on('tavolo:sbloccaConferma', () => {
    const ctx = tavoloDelSocket();
    if (!ctx) return;
    const { sessione, tavolo, sessionId, tavoloId } = ctx;
    if (sessione.inPausa) return;
    tavolo.confermato = false;
    sessionManager.salvaSuDisco();
    io.to(`tavolo:${sessionId}:${tavoloId}`).emit('tavolo:stato', vistaTavoloPerTeam(tavolo, sessione));
    io.to(`facilitatore:${sessionId}`).emit('facilitatore:stato', vistaSessionePerFacilitatore(sessione));
  });

  socket.on('facilitatore:sbloccaTavolo', ({ tavoloId }) => {
    const ctx = sessioneDelFacilitatore();
    if (!ctx) return;
    const { sessione, sessionId } = ctx;
    const tavolo = sessione.tavoli[tavoloId];
    if (!tavolo) return;
    tavolo.confermato = false;
    sessionManager.salvaSuDisco();
    broadcastStatoCompleto(sessionId);
  });

  socket.on('facilitatore:terminaFase1', () => {
    const ctx = sessioneDelFacilitatore();
    if (!ctx) return;
    const { sessione, sessionId } = ctx;
    if (sessione.stato !== 'fase1_classificazione') return;
    sessione.stato = 'lobby';
    sessionManager.salvaSuDisco();
    broadcastStatoCompleto(sessionId);
  });

  socket.on('facilitatore:avviaRound', () => {
    const ctx = sessioneDelFacilitatore();
    if (!ctx) return;
    const { sessione, sessionId } = ctx;
    if (sessione.stato !== 'lobby' && sessione.stato !== 'round_chiuso') return;

    const fasiConfig = sessione.gameConfig.fasi;
    const fase = gameEngine.calcolaFase(sessione.roundCorrente, fasiConfig);
    const oreBase = sessione.gameConfig.oreManagerialiPerRound;

    // Seed condiviso per questo round: tutti i tavoli della sessione affrontano la stessa
    // sequenza di richieste nello stesso round (equita' competitiva per la classifica).
    const seedRound = gameEngine.seedDaStringa(`${sessione.id}:${sessione.roundCorrente}`);

    for (const tavolo of Object.values(sessione.tavoli)) {
      tavolo.oreDisponibiliRound = fase === 3
        ? Math.round(oreBase * fasiConfig.crisi.moltiplicatoreOre)
        : oreBase;
      const rng = gameEngine.creaGeneratoreSeeded(seedRound);
      gameEngine.generaRichiesteRound(tavolo, sessione.roundCorrente, fase, fasiConfig, collaboratoriConfig, rng);
    }

    sessione.stato = 'in_round';
    sessione.roundIniziatoIl = Date.now(); // base per il countdown del timer, calcolato client-side
    sessionManager.salvaSuDisco();
    broadcastStatoCompleto(sessionId);
  });

  // Imposta la durata del countdown di settimana, in minuti. Funziona sia prima di avviare
  // una settimana (si applica alla prossima) sia a settimana gia' in corso: non tocca
  // roundIniziatoIl, quindi il tempo residuo si ricalcola subito sul nuovo totale la prossima
  // volta che il countdown lato tavolo fa un tick (che legge sempre roundIniziatoIl +
  // durataRoundSecondi "al volo", non un valore congelato all'avvio del round).
  socket.on('facilitatore:impostaDurataRound', ({ minuti }) => {
    const ctx = sessioneDelFacilitatore();
    if (!ctx) return;
    const { sessione, sessionId } = ctx;
    const secondi = Math.round(Number(minuti) * 60);
    if (!Number.isFinite(secondi) || secondi < 30 || secondi > 3600) {
      return socket.emit('errore', { messaggio: 'Durata non valida: deve essere tra 30 secondi e 60 minuti.' });
    }
    sessione.durataRoundSecondi = secondi;
    sessionManager.salvaSuDisco();
    broadcastStatoCompleto(sessionId);
  });

  // Riavvia il countdown del round corrente senza modificarne le scelte gia' sottomesse:
  // utile se la discussione in aula richiede piu' tempo di quello previsto.
  socket.on('facilitatore:riavviaTimer', () => {
    const ctx = sessioneDelFacilitatore();
    if (!ctx) return;
    const { sessione, sessionId } = ctx;
    if (sessione.stato !== 'in_round') return;
    sessione.roundIniziatoIl = Date.now();
    sessionManager.salvaSuDisco();
    broadcastStatoCompleto(sessionId);
  });

  // Pausa/ripresa: congela temporaneamente le azioni dei tavoli (il timer viene "sospeso"
  // traslando roundIniziatoIl in avanti della durata della pausa, cosi' il tempo residuo
  // del round non si consuma mentre si gestisce un imprevisto in aula).
  socket.on('facilitatore:pausa', () => {
    const ctx = sessioneDelFacilitatore();
    if (!ctx) return;
    const { sessione, sessionId } = ctx;
    if (sessione.inPausa) return;
    sessione.inPausa = true;
    sessione.pausaIniziataIl = Date.now();
    sessionManager.salvaSuDisco();
    broadcastStatoCompleto(sessionId);
  });

  socket.on('facilitatore:riprendi', () => {
    const ctx = sessioneDelFacilitatore();
    if (!ctx) return;
    const { sessione, sessionId } = ctx;
    if (!sessione.inPausa) return;
    if (sessione.roundIniziatoIl && sessione.pausaIniziataIl) {
      sessione.roundIniziatoIl += (Date.now() - sessione.pausaIniziataIl);
    }
    sessione.inPausa = false;
    sessione.pausaIniziataIl = null;
    sessionManager.salvaSuDisco();
    broadcastStatoCompleto(sessionId);
  });

  socket.on('facilitatore:chiudiRound', () => {
    const ctx = sessioneDelFacilitatore();
    if (!ctx) return;
    const { sessione, sessionId } = ctx;

    for (const tavolo of Object.values(sessione.tavoli)) {
      gameEngine.chiudiRound(tavolo, sessione.roundCorrente, azioniConfig, sessione.gameConfig, collaboratoriConfig, azioniSistemicheConfig, messaggiNarrativiConfig);
    }

    sessione.roundIniziatoIl = null;

    if (sessione.roundCorrente >= sessione.numeroRound) {
      sessione.stato = 'terminata';
      calcolaRisultatiFinali(sessione);
    } else {
      sessione.roundCorrente += 1;
      sessione.stato = 'round_chiuso';
    }

    sessionManager.salvaSuDisco();
    broadcastStatoCompleto(sessionId);
  });

  socket.on('facilitatore:iniettaEvento', ({ eventoId, tavoloId, collaboratoreId }) => {
    const ctx = sessioneDelFacilitatore();
    if (!ctx) return;
    const { sessione, sessionId } = ctx;
    const evento = gameConfigDefault.eventiFacilitatore.find((e) => e.id === eventoId);
    if (!evento) return;

    const applicaATavolo = (tavolo) => {
      if (evento.tipo === 'penalitaOreLibere') {
        const oreLibere = tavolo.oreDisponibiliRound - tavolo.oreUsateRound;
        if (oreLibere < 2) tavolo.oreUsateRound = tavolo.oreDisponibiliRound;
      } else if (evento.tipo === 'motivazioneCollaboratore') {
        const target = collaboratoreId
          ? tavolo.collaboratori.find((c) => c.id === collaboratoreId)
          : tavolo.collaboratori.find((c) => c.cluster === evento.clusterTarget);
        if (target) target.stats.motivazione = gameEngine.clamp(target.stats.motivazione + evento.delta);
      }
    };

    if (tavoloId) {
      const tavolo = sessione.tavoli[tavoloId];
      if (tavolo) applicaATavolo(tavolo);
    } else {
      Object.values(sessione.tavoli).forEach(applicaATavolo);
    }

    sessionManager.salvaSuDisco();
    const tavoliColpiti = tavoloId ? [tavoloId] : Object.keys(sessione.tavoli);
    for (const id of tavoliColpiti) {
      io.to(`tavolo:${sessionId}:${id}`).emit('evento:ricevuto', { titolo: evento.titolo, testo: evento.testo });
    }
    broadcastStatoCompleto(sessionId);
  });

  socket.on('facilitatore:terminaSessione', () => {
    const ctx = sessioneDelFacilitatore();
    if (!ctx) return;
    const { sessione, sessionId } = ctx;
    sessione.stato = 'terminata';
    calcolaRisultatiFinali(sessione);
    sessionManager.salvaSuDisco();
    broadcastStatoCompleto(sessionId);
  });
});

function calcolaRisultatiFinali(sessione) {
  const classifica = gameEngine.calcolaClassificaFinale(sessione.tavoli, sessione.gameConfig);
  const profili = {};
  const epiloghi = {};
  for (const tavolo of Object.values(sessione.tavoli)) {
    profili[tavolo.id] = profileEngine.calcolaProfilo(tavolo, profiliConfig, sessione.gameConfig);
    epiloghi[tavolo.id] = gameEngine.calcolaEpilogo(tavolo, epilogoConfig);
  }
  sessione.risultatiFinali = { classifica, profili, epiloghi };
}

function broadcastStatoCompleto(sessionId) {
  const sessione = sessionManager.getSessione(sessionId);
  if (!sessione) return;
  io.to(`facilitatore:${sessionId}`).emit('facilitatore:stato', pacchettoStatoFacilitatore(sessione));
  for (const tavolo of Object.values(sessione.tavoli)) {
    io.to(`tavolo:${sessionId}:${tavolo.id}`).emit('tavolo:stato', pacchettoStatoTeam(tavolo, sessione));
  }
}

server.listen(PORT, () => {
  console.log(`Less is More - server avviato su porta ${PORT}`);
});
