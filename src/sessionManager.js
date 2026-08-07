'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const gameEngine = require('./gameEngine');

const DATA_FILE = path.join(__dirname, '..', 'data', 'sessions.json');
const BACKUP_DIR = path.join(__dirname, '..', 'data', 'backups');

class SessionManager {
  constructor() {
    this.sessioni = {}; // sessionId -> sessione
    this._caricaDaDisco();
  }

  _caricaDaDisco() {
    try {
      if (fs.existsSync(DATA_FILE)) {
        const raw = fs.readFileSync(DATA_FILE, 'utf-8');
        this.sessioni = JSON.parse(raw);
      }
    } catch (err) {
      console.error('Impossibile caricare snapshot sessioni, riparto vuoto:', err.message);
      this.sessioni = {};
    }
  }

  // Salvataggio "debounced" e asincrono: ogni azione di gioco (submit, classificazione, ecc.)
  // chiama salvaSuDisco(), ma scrivere l'intero snapshot su disco in modo sincrono ad ogni
  // singola chiamata blocca l'event loop di Node — con piu' tavoli attivi in rapida
  // successione questo ha causato ritardi nell'elaborazione degli eventi socket in arrivo
  // (azioni scartate perche' processate dopo la chiusura del round). Le chiamate ravvicinate
  // vengono quindi raccolte e scritte una sola volta, in modo non bloccante, poco dopo
  // l'ultima modifica. Lo snapshot su disco resta comunque solo per il ripristino dopo un
  // riavvio: lo stato in memoria (autorevole per tutte le richieste) e' sempre aggiornato
  // immediatamente e in modo sincrono dai vari handler.
  salvaSuDisco() {
    this._salvataggioSporco = true;
    if (this._salvataggioProgrammato) return;
    this._salvataggioProgrammato = true;
    setTimeout(() => {
      this._salvataggioProgrammato = false;
      if (!this._salvataggioSporco) return;
      this._salvataggioSporco = false;
      try {
        fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
        const snapshot = JSON.stringify(this.sessioni);
        fs.writeFile(DATA_FILE, snapshot, (err) => {
          if (err) console.error('Errore salvataggio snapshot sessioni:', err.message);
        });
      } catch (err) {
        console.error('Errore salvataggio snapshot sessioni:', err.message);
      }
    }, 80);
  }

  creaSessione({ nome, numeroTavoli, nomiTavoli, gameConfig, collaboratoriConfig }) {
    const id = uuidv4().slice(0, 8);
    const tavoli = {};
    const nomi = nomiTavoli && nomiTavoli.length === numeroTavoli
      ? nomiTavoli
      : Array.from({ length: numeroTavoli }, (_, i) => `Tavolo ${i + 1}`);

    const gameConfigCalcolato = {
      ...gameConfig,
      numeroRound: gameEngine.numeroRoundTotali(gameConfig.fasi)
    };

    for (let i = 0; i < numeroTavoli; i++) {
      const tavoloId = uuidv4().slice(0, 6);
      const codiceAccesso = generaCodice();
      tavoli[tavoloId] = gameEngine.nuovoTavolo(tavoloId, nomi[i], codiceAccesso, collaboratoriConfig, gameConfigCalcolato);
      // Token del tavolo: verificato server-side a ogni tavolo:join, cosi' l'accesso al tavolo
      // richiede di aver risolto il codice (o scansionato il QR) e non solo di conoscerne l'id.
      tavoli[tavoloId].token = generaToken();
    }

    const sessione = {
      id,
      nome: nome || `Sessione ${new Date().toLocaleDateString('it-IT')}`,
      // fase1_classificazione -> lobby -> in_round -> round_chiuso -> ... -> terminata
      stato: 'fase1_classificazione',
      roundCorrente: 1,
      numeroRound: gameConfigCalcolato.numeroRound,
      gameConfig: gameConfigCalcolato,
      tavoli,
      creataIl: new Date().toISOString(),
      // Token del facilitatore: rivelato una sola volta nella risposta di creazione sessione,
      // richiesto per leggere lo stato completo della sessione e per la regia via socket.
      tokenFacilitatore: generaToken(),
      // --- Strumenti operativi ---
      roundIniziatoIl: null, // timestamp ms: base per il countdown del timer di round (client-side)
      inPausa: false,
      pausaIniziataIl: null, // timestamp ms: usato per traslare roundIniziatoIl alla ripresa, cosi' il tempo residuo del round non si consuma durante la pausa
      // Durata del countdown di settimana, in secondi: parte dal default di config ma il
      // facilitatore puo' modificarla in qualsiasi momento (anche a settimana in corso, vedi
      // facilitatore:impostaDurataRound) — il countdown lato tavolo si ricalcola da solo perche'
      // e' sempre derivato da roundIniziatoIl + durataRoundSecondi ad ogni tick.
      durataRoundSecondi: gameConfigCalcolato.durataRoundSecondi || 300
    };

    this.sessioni[id] = sessione;
    this.salvaSuDisco();
    return sessione;
  }

  getSessione(id) {
    return this.sessioni[id];
  }

  elencoSessioni() {
    return Object.values(this.sessioni).map((s) => ({
      id: s.id,
      nome: s.nome,
      stato: s.stato,
      roundCorrente: s.roundCorrente,
      numeroRound: s.numeroRound,
      numeroTavoli: Object.keys(s.tavoli).length,
      creataIl: s.creataIl
    }));
  }

  eliminaSessione(id) {
    delete this.sessioni[id];
    this.salvaSuDisco();
  }

  // --- Backup/restore manuale: mitiga la fragilita' del salvataggio non atomico su
  // sessions.json, permettendo al facilitatore di fissare un checkpoint prima di un
  // momento delicato (es. round di crisi) e tornarci indietro se qualcosa va storto. ---

  creaBackup(sessionId) {
    const sessione = this.sessioni[sessionId];
    if (!sessione) return null;
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const timestamp = Date.now();
    const backupId = `${sessionId}-${timestamp}`;
    const filePath = path.join(BACKUP_DIR, `${backupId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(sessione, null, 2));
    return {
      backupId,
      timestamp,
      creatoIl: new Date(timestamp).toISOString(),
      roundCorrente: sessione.roundCorrente,
      stato: sessione.stato
    };
  }

  elencoBackup(sessionId) {
    try {
      fs.mkdirSync(BACKUP_DIR, { recursive: true });
      const prefisso = `${sessionId}-`;
      return fs.readdirSync(BACKUP_DIR)
        .filter((f) => f.startsWith(prefisso) && f.endsWith('.json'))
        .map((f) => {
          const backupId = f.replace(/\.json$/, '');
          const timestamp = Number(backupId.slice(prefisso.length));
          let roundCorrente = null;
          let stato = null;
          try {
            const raw = JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, f), 'utf-8'));
            roundCorrente = raw.roundCorrente;
            stato = raw.stato;
          } catch (err) { /* backup illeggibile: lo elenchiamo comunque con dati parziali */ }
          return { backupId, timestamp, creatoIl: new Date(timestamp).toISOString(), roundCorrente, stato };
        })
        .sort((a, b) => b.timestamp - a.timestamp);
    } catch (err) {
      return [];
    }
  }

  ripristinaBackup(sessionId, backupId) {
    if (!backupId.startsWith(`${sessionId}-`)) return { ok: false, motivo: 'backup non appartiene a questa sessione' };
    const filePath = path.join(BACKUP_DIR, `${backupId}.json`);
    if (!fs.existsSync(filePath)) return { ok: false, motivo: 'backup non trovato' };
    try {
      const ripristinata = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      this.sessioni[sessionId] = ripristinata;
      this.salvaSuDisco();
      return { ok: true, sessione: ripristinata };
    } catch (err) {
      return { ok: false, motivo: 'backup corrotto: ' + err.message };
    }
  }
}

function generaCodice() {
  const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // senza caratteri ambigui
  let codice = '';
  for (let i = 0; i < 5; i++) codice += alfabeto[Math.floor(Math.random() * alfabeto.length)];
  return codice;
}

// Token opaco non indovinabile (32 caratteri esadecimali) per l'autenticazione leggera
// di regia/tavoli: non un JWT, solo un segreto lungo verificato per confronto diretto.
function generaToken() {
  return crypto.randomBytes(16).toString('hex');
}

module.exports = new SessionManager();
