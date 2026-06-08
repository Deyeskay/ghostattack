const CONFIG = {
    PEER_PREFIX: 'phantom-cells-v1-',
    TICK_RATE: 1000,
    ROUND_TIME: 30
};

const app = {
    peer: null,
    conn: null,
    isHost: false,
    connections: [], // Host only
    
    state: {
        phase: 'SETUP', // SETUP, LOBBY, PLAYING, GAMEOVER
        roomCode: '',
        teamSize: 5,
        round: 1,
        timeLeft: CONFIG.ROUND_TIME,
        players: {}, // peerId -> { name, team, col, pos, alive, action, ready, connected }
        history: []
    },

    myId: null,
    myName: '',
    selectedAction: null, // { type: 'move' | 'defend' | 'attack', target: 'A1' }

    init() {
        const savedName = localStorage.getItem('pc_name');
        if (savedName) document.getElementById('player-name').value = savedName;
    },

    showScreen(id) {
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        document.getElementById(id).classList.add('active');
    },

    generateRoomCode() {
        return Math.random().toString(36).substring(2, 6).toUpperCase();
    },

    async setupPeer(id) {
        return new Promise((resolve, reject) => {
            app.peer = new Peer(CONFIG.PEER_PREFIX + id);
            app.peer.on('open', resolve);
            app.peer.on('error', reject);
        });
    },

    // --- HOST LOGIC ---

    async hostGame() {
        const name = document.getElementById('player-name').value.trim().toUpperCase();
        if (!name) return app.showError("ENTER CODENAME");
        
        app.myName = name;
        localStorage.setItem('pc_name', name);
        app.isHost = true;
        const code = app.generateRoomCode();
        
        try {
            app.myId = await app.setupPeer(code);
            app.state.roomCode = code;
            app.state.phase = 'LOBBY';
            app.addPlayer(app.myId, name);
            
            app.peer.on('connection', app.handleHostConnection);
            
            document.getElementById('display-room-code').innerText = code;
            document.getElementById('host-controls').style.display = 'block';
            document.getElementById('start-game-btn').style.display = 'block';
            app.showScreen('lobby-screen');
            app.renderLobby();
        } catch (e) {
            app.showError("NETWORK ERROR. TRY AGAIN.");
        }
    },

    handleHostConnection(conn) {
        conn.on('data', (data) => {
            if (data.type === 'JOIN') {
                if (app.state.phase !== 'LOBBY' && !app.state.players[conn.peer]) {
                    conn.send({ type: 'ERROR', msg: 'GAME IN PROGRESS' });
                    return;
                }
                if (!app.connections.includes(conn)) app.connections.push(conn);
                app.addPlayer(conn.peer, data.name);
                app.broadcastState();
            } else if (data.type === 'ACTION') {
                app.handleClientAction(conn.peer, data.action);
            }
        });
        conn.on('close', () => {
            if (app.state.players[conn.peer]) app.state.players[conn.peer].connected = false;
            app.connections = app.connections.filter(c => c !== conn);
            app.broadcastState();
        });
    },

    addPlayer(id, name) {
        if (app.state.players[id]) {
            app.state.players[id].connected = true;
            app.state.players[id].name = name;
            return;
        }

        const currentPlayers = Object.values(app.state.players);
        const blueCount = currentPlayers.filter(p => p.team === 'BLUE').length;
        const redCount = currentPlayers.filter(p => p.team === 'RED').length;
        
        const team = blueCount <= redCount ? 'BLUE' : 'RED';
        const col = (team === 'BLUE' ? blueCount : redCount) + 1;

        app.state.players[id] = {
            id: id,
            name: name,
            team: team,
            col: col,
            pos: 'B', // Starts in back row
            alive: true,
            action: null,
            ready: false,
            connected: true,
            defending: false
        };
    },

    changeTeamSize() {
        if (!app.isHost) return;
        app.state.teamSize = parseInt(document.getElementById('team-size-select').value);
        app.broadcastState();
    },

    startGame() {
        if (!app.isHost) return;
        app.state.phase = 'PLAYING';
        app.state.round = 1;
        app.startRoundTimer();
        app.broadcastState();
        app.renderGame();
    },

    broadcastState() {
        if (!app.isHost) return;
        
        // Sanitize state for clients (hide exact enemy positions if alive)
        const sanitizedPlayers = {};
        for (const [id, p] of Object.entries(app.state.players)) {
            sanitizedPlayers[id] = { ...p };
        }

        const statePayload = {
            type: 'STATE_UPDATE',
            state: { ...app.state, players: sanitizedPlayers }
        };

        app.connections.forEach(conn => conn.send(statePayload));
        app.processState(statePayload.state); // Update own UI
    },

    handleClientAction(id, actionData) {
        const p = app.state.players[id];
        if (!p || !p.alive || p.ready) return;
        
        p.action = actionData;
        p.ready = true;
        
        app.broadcastState();
        app.checkRoundReady();
    },

    timerInterval: null,
    startRoundTimer() {
        clearInterval(app.timerInterval);
        app.state.timeLeft = CONFIG.ROUND_TIME;
        app.timerInterval = setInterval(() => {
            app.state.timeLeft--;
            app.broadcastState();
            if (app.state.timeLeft <= 0) {
                clearInterval(app.timerInterval);
                app.forceReadyAndResolve();
            }
        }, 1000);
    },

    checkRoundReady() {
        const alivePlayers = Object.values(app.state.players).filter(p => p.alive);
        if (alivePlayers.length > 0 && alivePlayers.every(p => p.ready)) {
            clearInterval(app.timerInterval);
            app.resolveRound();
        }
    },

    forceReadyAndResolve() {
        Object.values(app.state.players).forEach(p => {
            if (p.alive && !p.ready) {
                p.action = { type: 'defend' }; // Default action if timeout
                p.ready = true;
            }
        });
        app.resolveRound();
    },

    resolveRound() {
        const players = app.state.players;
        const roundEvents = [];
        roundEvents.push(`ROUND ${app.state.round}`);

        // Step 1: Moves
        for (const id in players) {
            const p = players[id];
            p.defending = false;
            if (p.alive && p.action.type === 'move') {
                p.pos = p.pos === 'A' ? 'B' : 'A';
            }
        }

        // Step 2: Defenders
        for (const id in players) {
            const p = players[id];
            if (p.alive && p.action.type === 'defend') {
                p.defending = true;
            }
        }

        // Step 3: Attacks
        for (const id in players) {
            const attacker = players[id];
            if (attacker.alive && attacker.action.type === 'attack') {
                const targetCell = attacker.action.target; // e.g. "A3"
                const targetRow = targetCell.charAt(0);
                const targetCol = parseInt(targetCell.substring(1));
                
                // Find enemy in that cell
                const enemyTeam = attacker.team === 'BLUE' ? 'RED' : 'BLUE';
                const targetPlayer = Object.values(players).find(p => 
                    p.team === enemyTeam && p.col === targetCol && p.pos === targetRow && p.alive
                );

                if (!targetPlayer) {
                    roundEvents.push(`<span class="log-event miss">${attacker.name} Attack ${targetCell} -> MISS</span>`);
                } else if (targetPlayer.defending) {
                    roundEvents.push(`<span class="log-event blocked">${attacker.name} Attack ${targetCell} -> BLOCKED</span>`);
                } else {
                    targetPlayer.alive = false;
                    roundEvents.push(`<span class="log-event eliminated">${attacker.name} Attack ${targetCell} -> ELIMINATED ${targetPlayer.name}</span>`);
                }
            }
        }

        app.state.history.push(...roundEvents);

        // Reset for next round
        for (const id in players) {
            players[id].ready = false;
            players[id].action = null;
        }

        app.state.round++;
        
        // Check Win Condition
        const blueAlive = Object.values(players).filter(p => p.team === 'BLUE' && p.alive).length > 0;
        const redAlive = Object.values(players).filter(p => p.team === 'RED' && p.alive).length > 0;

        if (!blueAlive || !redAlive) {
            app.state.phase = 'GAMEOVER';
            app.state.winner = !blueAlive && !redAlive ? 'DRAW' : (blueAlive ? 'TEAM BLUE WINS' : 'TEAM RED WINS');
            app.broadcastState();
        } else {
            app.startRoundTimer();
            app.broadcastState();
        }
    },


    // --- CLIENT LOGIC ---

    async joinGame() {
        const name = document.getElementById('player-name').value.trim().toUpperCase();
        const code = document.getElementById('room-code-input').value.trim().toUpperCase();
        
        if (!name || !code) return app.showError("ENTER CODENAME AND ROOM CODE");
        
        app.myName = name;
        localStorage.setItem('pc_name', name);
        app.isHost = false;
        
        try {
            app.myId = await app.setupPeer(name + Math.random().toString(16).slice(2)); // Random ID for client
            app.conn = app.peer.connect(CONFIG.PEER_PREFIX + code);
            
            app.conn.on('open', () => {
                app.conn.send({ type: 'JOIN', name: name });
            });

            app.conn.on('data', (data) => {
                if (data.type === 'STATE_UPDATE') {
                    app.processState(data.state);
                } else if (data.type === 'ERROR') {
                    app.showError(data.msg);
                    app.conn.close();
                }
            });

            document.getElementById('display-room-code').innerText = code;
            app.showScreen('lobby-screen');
            
        } catch (e) {
            app.showError("CONNECTION FAILED");
        }
    },

    processState(newState) {
        app.state = newState;
        
        if (app.state.phase === 'LOBBY') {
            app.showScreen('lobby-screen');
            app.renderLobby();
        } else if (app.state.phase === 'PLAYING') {
            if (document.getElementById('game-screen').classList.contains('active') === false) {
                app.showScreen('game-screen');
                app.selectedAction = null;
            }
            app.renderGame();
        } else if (app.state.phase === 'GAMEOVER') {
            app.showScreen('end-screen');
            document.getElementById('winner-text').innerText = app.state.winner;
            document.getElementById('winner-text').style.color = app.state.winner.includes('BLUE') ? 'var(--neon-blue)' : 'var(--neon-red)';
        }
    },

    selectAction(type) {
        const me = app.state.players[app.myId];
        if (!me || !me.alive || me.ready) return;

        document.querySelectorAll('.act-btn').forEach(b => b.classList.remove('active-action'));
        document.getElementById(`btn-${type}`).classList.add('active-action');

        if (type === 'move' || type === 'defend') {
            app.selectedAction = { type: type };
            document.getElementById('action-status').innerText = `SELECTED: ${type.toUpperCase()}`;
            app.renderGame(); // Clear targets
        } else if (type === 'attack') {
            app.selectedAction = { type: 'attack', target: null };
            document.getElementById('action-status').innerText = `SELECT TARGET ON ENEMY GRID`;
            app.renderGame(); // Allow target selection
        }
    },

    selectTarget(cellId) {
        if (app.selectedAction && app.selectedAction.type === 'attack') {
            app.selectedAction.target = cellId;
            document.getElementById('action-status').innerText = `TARGET LOCKED: ${cellId}`;
            app.renderGame(); // Update target highlight
        }
    },

    submitReady() {
        const me = app.state.players[app.myId];
        if (!me || !me.alive || me.ready) return;

        if (!app.selectedAction) {
            app.showActionError("NO ACTION SELECTED");
            return;
        }

        if (app.selectedAction.type === 'attack' && !app.selectedAction.target) {
            app.showActionError("SELECT A TARGET CELL");
            return;
        }

        if (app.isHost) {
            app.handleClientAction(app.myId, app.selectedAction);
        } else {
            app.conn.send({ type: 'ACTION', action: app.selectedAction });
        }
        
        document.getElementById('action-status').innerText = "ORDERS SUBMITTED";
        document.getElementById('btn-ready').disabled = true;
    },

    // --- RENDERING ---

    renderLobby() {
        const blueList = document.getElementById('blue-team-list');
        const redList = document.getElementById('red-team-list');
        blueList.innerHTML = '';
        redList.innerHTML = '';

        Object.values(app.state.players).forEach(p => {
            const li = document.createElement('li');
            li.innerText = `${p.name} [COL ${p.col}]` + (!p.connected ? ' (DC)' : '');
            if (p.team === 'BLUE') blueList.appendChild(li);
            else redList.appendChild(li);
        });
    },

    renderGame() {
        const me = app.state.players[app.myId] || { team: 'SPECTATOR', alive: false };
        
        // Top Bar
        document.getElementById('round-display').innerText = app.state.round;
        document.getElementById('timer-display').innerText = app.state.timeLeft;
        document.getElementById('alive-display').innerText = Object.values(app.state.players).filter(p=>p.alive).length;

        // Grids
        const cols = app.state.teamSize;
        const enemyGrid = document.getElementById('enemy-grid');
        const allyGrid = document.getElementById('ally-grid');
        
        enemyGrid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
        allyGrid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
        
        enemyGrid.innerHTML = '';
        allyGrid.innerHTML = '';

        // Build boards
        ['A', 'B'].forEach(row => {
            for (let c = 1; c <= cols; c++) {
                const cellId = `${row}${c}`;
                
                // Ally Cell
                const aCell = document.createElement('div');
                aCell.className = 'cell';
                aCell.id = `ally-${cellId}`;
                
                // Find ally in this cell
                const ally = Object.values(app.state.players).find(p => p.team === me.team && p.pos === row && p.col === c);
                if (ally) {
                    if (ally.alive) {
                        aCell.classList.add('ally-occupied');
                        aCell.innerText = ally.id === app.myId ? 'YOU' : `P${ally.col}`;
                    } else {
                        aCell.classList.add('dead');
                        aCell.innerText = 'X';
                    }
                } else {
                    aCell.innerText = cellId;
                }
                allyGrid.appendChild(aCell);

                // Enemy Cell
                const eCell = document.createElement('div');
                eCell.className = 'cell';
                eCell.id = `enemy-${cellId}`;
                
                // Find enemy (only show if dead due to host sanitization/rules)
                const enemyTeam = me.team === 'BLUE' ? 'RED' : 'BLUE';
                const enemy = Object.values(app.state.players).find(p => p.team === enemyTeam && p.pos === row && p.col === c);
                
                if (enemy && !enemy.alive) {
                    eCell.classList.add('dead', 'enemy-occupied');
                    eCell.innerText = 'X';
                } else {
                    eCell.innerText = '?';
                    if (me.alive && !me.ready && app.selectedAction && app.selectedAction.type === 'attack') {
                        eCell.classList.add('selectable');
                        eCell.onclick = () => app.selectTarget(cellId);
                        if (app.selectedAction.target === cellId) {
                            eCell.classList.add('targeted');
                        }
                    }
                }
                enemyGrid.appendChild(eCell);
            }
        });

        // Controls
        const readyBtn = document.getElementById('btn-ready');
        if (!me.alive) {
            document.getElementById('action-status').innerText = "SPECTATING";
            readyBtn.disabled = true;
            document.querySelectorAll('.act-btn').forEach(b => b.disabled = true);
        } else if (me.ready) {
            readyBtn.disabled = true;
            document.querySelectorAll('.act-btn').forEach(b => b.disabled = true);
        } else {
            readyBtn.disabled = false;
            document.querySelectorAll('.act-btn').forEach(b => b.disabled = false);
        }

        // History
        const log = document.getElementById('history-log');
        log.innerHTML = app.state.history.map(item => `<div>${item}</div>`).join('');
        log.scrollTop = log.scrollHeight;
    },

    showError(msg) {
        document.getElementById('setup-error').innerText = msg;
        setTimeout(() => document.getElementById('setup-error').innerText = '', 3000);
    },
    
    showActionError(msg) {
        const status = document.getElementById('action-status');
        const old = status.innerText;
        status.innerText = msg;
        status.style.color = 'var(--neon-red)';
        setTimeout(() => {
            status.innerText = old;
            status.style.color = 'var(--neon-blue)';
        }, 2000);
    }
};

window.onload = app.init;