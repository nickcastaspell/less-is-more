# LESS IS MORE — Business Game

Leadership Through Smart Resource Allocation. Web app multi-tavolo con regia facilitatore, per aule di formazione aziendale e convention.

## Cos'è

Un facilitatore crea una sessione da un computer/proiettore (la "regia"). Ogni tavolo si collega da smartphone o tablet tramite link o QR code personale. La partita si sviluppa in 4 fasi:

- **Fase 1 — Conoscere**: i tavoli leggono le schede cartacee dei collaboratori e li classificano in app (Investirei / Monitorerei / Lascerei autonomo). Questa etichetta — non il cluster reale, che resta interno al motore — è quella mostrata per tutta la partita, e resta modificabile in ogni momento se un collaboratore sembra cambiare.
- **Fase 2 — Scegliere**: round in cui i collaboratori inviano richieste asimmetriche (chi assorbe più energie chiama quasi sempre, i migliori quasi mai). Il tavolo distribuisce ore manageriali limitate tra 8 tipi di intervento, inclusa la "visita proattiva" per chi non ha chiesto nulla. È garantito che, entro una finestra configurabile, capiti almeno un turno in cui nessuno chiama.
- **Fase 3 — Crisi**: un round con ore ridotte e richieste moltiplicate, per vedere chi regge e chi no. A round chiuso, ogni tavolo riceve un breve recap narrativo (non solo numeri) di quante richieste sono arrivate durante la crisi, quante sono state gestite e quali conseguenze ha avuto la scelta di chi seguire e chi no.
- **Fase 4 — Consolidare**: si affiancano alle azioni individuali delle leve sistemiche (buddy, mentoring, community, checklist...) che riducono nel tempo il bisogno della rete di rivolgersi al manager — il vero indicatore finale di "Less is More". Quando l'effetto si nota davvero (calo sostanziale delle richieste dirette rispetto a Fase 2), il tavolo riceve un messaggio narrativo dedicato la prima volta che succede.

A fine sessione la piattaforma calcola una classifica multi-criterio, mostra l'evoluzione delle "richieste al manager" round per round, assegna a ogni tavolo un profilo manageriale (Coltivatore, Stratega, Controllore, Salvatore, Pompiere, Accentratore) come base per il debrief, e chiude con un breve epilogo narrativo — "una settimana senza di voi" — che immagina cosa succederebbe alla rete costruita, in base a quanto è risultata autonoma o dipendente dal manager.

## Requisiti

- Node.js 18 o superiore
- Un hosting che supporti processi Node persistenti con WebSocket (Render, Railway, Fly.io, un server aziendale, un VPS, o anche il tuo Mac con hotspot locale il giorno dell'evento). **Non funziona su hosting solo-statico** (es. semplice hosting di file HTML) perché richiede un backend con Socket.io.

## Installazione locale

```bash
cd less-is-more-game
npm install
npm start
```

Il server parte su `http://localhost:3000` (porta configurabile con la variabile d'ambiente `PORT`).

- Regia facilitatore: `http://localhost:3000/facilitatore/`
- Accesso tavolo (di solito non ci si va manualmente: si usa il link/QR generato dalla regia): `http://localhost:3000/tavolo/`

## Test automatico

Cinque suite coprono l'intero motore, il flusso a 4 fasi, la sicurezza dell'accesso e gli strumenti operativi del facilitatore:

```bash
node test/unit_engine.js          # motore puro: fasi, richieste, azioni sistemiche, narrativa, PRNG seedato, epilogo (no server)
node server.js &                  # avvia il server in background
node test/simulate.js             # regressione motore profili (3 tavoli, stili diversi, Fase 2) + verifica token
node test/simulate_fasi.js        # flusso end-to-end completo delle 4 fasi via socket
node test/test_sicurezza_socket.js # verifica che un tavolo non possa impersonarne un altro (spoofing bloccato)
node test/test_strumenti_operativi.js # timer, lock/sblocco round, pausa/ripresa, backup/restore
```

Utile per controllare l'installazione dopo modifiche ai file di configurazione.

## Sicurezza e accesso (token)

Ogni sessione ha un **token facilitatore** e ogni tavolo ha un proprio **token**, entrambi generati automaticamente alla creazione — non serve configurare nulla.

- Il token facilitatore viene rivelato una sola volta, nella risposta di creazione sessione: il browser lo salva in `localStorage` per riaprire la regia in un secondo momento senza reinserirlo. Serve per leggere lo stato completo di una sessione (`GET /api/sessioni/:id`), per generare i link/QR dei tavoli, e per unirsi alla regia via socket.
- Il token di ogni tavolo è incorporato nel link/QR generato dalla regia (parametro `tok`) e viene restituito automaticamente anche quando un partecipante inserisce a mano il codice a 5 caratteri del proprio tavolo. Serve per unirsi a quel tavolo via socket.
- Lato server, ogni socket "ricorda" la sessione/tavolo/ruolo verificati al momento del join (non più dati inviati a ogni evento dal client): un tavolo non può quindi agire su un altro tavolo, né un socket non autenticato come regia può controllare i round, anche costruendo pacchetti di rete manuali.
- Anche la generazione delle richieste in arrivo usa un generatore pseudocasuale seedato per sessione+round, cosicché tutti i tavoli di una stessa sessione affrontino la stessa sequenza di richieste nello stesso round — la classifica finale confronta quindi scelte fatte sulle stesse condizioni, non fortuna diversa tra tavoli.

Se apri la regia da un altro browser/computer (o dopo aver svuotato la cache), ti verrà richiesto di incollare il token facilitatore ricevuto alla creazione della sessione.

## Deploy su un hosting (es. Render / Railway / Fly.io)

1. Crea un nuovo servizio "Web Service" collegato al repository (o carica i file via CLI/FTP se l'hosting lo prevede).
2. Comando di build: `npm install`. Comando di avvio: `npm start`.
3. Imposta la variabile d'ambiente `PORT` solo se l'hosting non la fornisce già automaticamente (Render/Railway la impostano da soli).
4. Se il servizio ha un dominio diverso da quello mostrato nei link generati (capita con reverse proxy), imposta la variabile d'ambiente `PUBLIC_BASE_URL` (es. `https://ilmiogioco.onrender.com`) così i link/QR per i tavoli useranno l'indirizzo corretto anche dietro proxy.
5. Verifica che il piano scelto non "addormenti" il servizio con più di qualche secondo di ritardo al risveglio — per un evento dal vivo conviene un piano always-on o un ping di keep-alive nei minuti prima dell'inizio.

In alternativa, per un evento in presenza, il server può girare direttamente sul portatile del facilitatore collegato a un hotspot locale creato per l'occasione: nessuna dipendenza da internet della sede, ma tieni il portatile sotto corrente, disattiva la sospensione (es. `caffeinate -di` su Mac prima di `npm start`) e testa la copertura wifi nella sala reale in anticipo.

## Personalizzare i contenuti (senza toccare il codice)

Tutti i contenuti e il bilanciamento del gioco vivono in `config/*.json`:

- `config/collaboratori.json` — nomi, cluster reale (performer / potenziale / resistente, interno al motore), propensione a chiedere aiuto e richieste tipiche per cluster, e le categorie di classificazione mostrate ai tavoli in Fase 1.
- `config/azioni.json` — le 8 tipologie di intervento individuale (incluse "visita proattiva"), il loro costo in ore e gli effetti (immediati e differiti) su ciascun cluster.
- `config/azioniSistemiche.json` — le azioni di Fase 4 (buddy, mentoring, community...), che agiscono sull'intera rete invece che su un singolo collaboratore.
- `config/profili.json` — i 6 profili manageriali finali e le loro "impronte" comportamentali usate per l'assegnazione automatica a fine sessione.
- `config/messaggiNarrativi.json` — le regole (generiche, non legate a nomi specifici) che generano i messaggi di dipendenza e abbandono durante la partita.
- `config/gameConfig.json` — struttura delle fasi (round di Fase 2/4, parametri della crisi di Fase 3, finestra del turno silenzioso garantito), ore manageriali per round, pesi della classifica finale, eventi opzionali che il facilitatore può iniettare durante il gioco.

Dopo aver modificato un file JSON, riavvia il server (`npm start`) perché i file vengono letti all'avvio. Se cambi la struttura dei dati (es. rinomini un campo), esegui le tre suite di test per accertarti che tutto funzioni ancora.

Il numero di round di Fase 2/4 e le ore per round possono anche essere impostati per singola sessione dal form "Nuova sessione" nella regia, senza toccare i file. Fase 1 (classificazione) e Fase 3 (crisi, sempre 1 round) si aggiungono automaticamente.

## Il giorno dell'evento

1. Il facilitatore apre `/facilitatore/`, crea la sessione indicando numero di tavoli (e opzionalmente i loro nomi).
2. La schermata "Sala d'attesa" mostra un link + QR per ciascun tavolo: proiettali o condividili, ogni tavolo apre il proprio dal telefono.
3. Il facilitatore passa alla Fase 1: ogni tavolo legge le schede cartacee e classifica i propri collaboratori in app. Quando ritiene che abbiano finito, clicca "Passa alla Fase 2" — la classificazione resta comunque modificabile per tutta la partita.
4. Da qui la regia procede settimana per settimana come di consueto: "Avvia Settimana" apre la settimana (generando le richieste in arrivo per ogni tavolo), i tavoli agiscono entro le ore disponibili, "Chiudi Settimana" applica gli effetti. La settimana di Fase 3 (crisi) scatta automaticamente con ore ridotte e richieste moltiplicate; da lì in poi si entra in Fase 4, con le azioni sistemiche disponibili in aggiunta a quelle individuali.
5. Il facilitatore può iniettare eventi opzionali extra in qualsiasi settimana dal pannello dedicato; i tavoli li vedono comparire come banner immediato sullo schermo.
6. Alla fine dell'ultimo round la piattaforma mostra automaticamente classifica finale, evoluzione delle "richieste al manager" e profilo manageriale di ogni tavolo, sia in regia sia sugli schermi dei tavoli — base pronta per il debrief (le domande guida sono incluse nella schermata finale della regia, insieme al log completo delle decisioni per tavolo).

## Strumenti operativi per il facilitatore

Oltre alla conduzione settimana per settimana, la regia offre alcuni strumenti pensati per la gestione live in aula:

- **Timer di settimana**: regia e tavoli mostrano un conto alla rovescia (default 5 minuti, configurabile in `gameConfig.json` con `durataRoundSecondi`). Il facilitatore ha anche un campo "Durata settimana" direttamente in regia per cambiare la durata in qualunque momento — anche a settimana già avviata, senza toccare le scelte già inviate — non serve modificare i file di configurazione né riavviare il server. Il facilitatore può inoltre riavviare il conto alla rovescia in qualsiasi momento (es. se la discussione in aula richiede più tempo).
- **Blocco dopo conferma**: quando un tavolo conferma le proprie scelte per la settimana ("Ho deciso per questa settimana"), quelle scelte vengono bloccate lato server, non solo visivamente — non si può più modificarle per errore. Il tavolo stesso può sempre auto-sbloccarsi per correggersi, e il facilitatore può sbloccare un tavolo specifico dalla regia se serve.
- **Pausa**: il facilitatore può mettere in pausa la sessione (es. per una domanda, un imprevisto, una pausa caffè non prevista): i tavoli vedono un overlay dedicato e non possono inviare azioni finché non si riprende; il timer della settimana si "congela" e riparte da dove si era fermato.
- **Backup manuale**: dalla regia si può salvare in ogni momento un checkpoint della sessione e, se qualcosa va storto, ripristinarlo — indipendente dal salvataggio automatico che avviene comunque ad ogni azione.

## La "scrivania" del tavolo

Durante una settimana attiva, l'interfaccia del tavolo è organizzata come una scrivania con 4 aree navigabili (in quest'ordine):

- **👥 Team** — le schede dei collaboratori. Niente numeri: ogni scheda mostra le stelle (indicatore complessivo 1-5, media di tutte le statistiche visibili) e tre barre di avanzamento — Autonomia, Motivazione, Competenza — ciascuna con una freccia (▲/▼/→) che confronta la settimana appena chiusa con la media mobile delle 3 precedenti (nessuna freccia finché non c'è abbastanza storia, cioè in settimana 1). La tendina "classifica" resta sempre in scheda. La scheda intera è cliccabile: apre la Cronologia del collaboratore (storico leggibile settimana per settimana). Da lì, solo a partire dalla prima settimana di Fase 2 (in Fase 1 i collaboratori non "fanno" ancora nulla), si può scegliere un intervento — con una lista di opzioni e un pulsante "Conferma" da cliccare esplicitamente, non una tendina che invia da sola al primo cambio.
- **📱 Telefono** — le richieste dei collaboratori arrivano qui come notifiche; toccandole si apre una finestra compatta per scegliere l'intervento (stessa azione disponibile anche dalla scheda in Team/Cronologia — sono più strade per la stessa cosa). Una richiesta già gestita è marcata con un bordo verde e un badge di spunta ben visibile in alto a destra sulla notifica.
- **📊 Cruscotto** — clima della rete, ore disponibili, fase/settimana corrente e quanti collaboratori aspettano ancora una risposta.
- **📅 Agenda** — ore disponibili e l'elenco di cosa è già stato pianificato per questa settimana (azioni individuali e sistemiche).

In Fase 3 la crisi cambia leggermente il tono di tutta la schermata (sfondo più caldo), non solo un banner. I file `mockup-redesign-tavolo.html` e `mockup-scrivania-dlg.html` (inclusi in questo pacchetto) restano come bozze statiche usate per validare la direzione visiva prima di scriverla nel codice — non sono più necessari per capire l'app, ma sono utili come riferimento di design.

Nota su Resilienza: nel motore attuale è un tratto fisso assegnato a inizio partita e non cambia mai in base alle azioni — per questo la terza barra mostra Competenza (che invece si muove davvero settimana su settimana) al posto suo. Resilienza resta comunque visibile come dato nella scheda cartacea stampabile del collaboratore.

## Note tecniche

- Stato di gioco tenuto in memoria (sempre autorevole per l'app) e salvato automaticamente su `data/sessions.json` poco dopo ogni azione, in modo asincrono: se il processo si riavvia (es. crash, redeploy), la sessione in corso viene recuperata. Per un checkpoint puntuale e garantito, usa il backup manuale dalla regia.
- Comunicazione in tempo reale via Socket.io (WebSocket con fallback automatico) tra regia e tavoli: aggiornamenti istantanei, non serve ricaricare la pagina.
- Nessun dato lascia il server: non ci sono servizi esterni o account richiesti per i partecipanti, solo il link/QR fornito.
- Il profilo manageriale finale distingue "delega" (scelta attiva di responsabilizzazione) da "nessun intervento" (assenza di azione): sono due metriche separate in `config/profili.json`, non più una sola. Le ore spese in azioni sistemiche di Fase 4 sono incluse nel totale ore del tavolo (contano quindi anche in efficienza e concentrazione).
