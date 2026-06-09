const CONFIG = {
    PEER_PREFIX: 'phantom-cells-v1-',
    TICK_RATE: 1000,
    ROUND_TIME: 30,
    INTERMISSION_TIME: 15
};

const app = {
    peer: null,
    conn: null,
    isHost: false,
    connections: [],
    hasManuallyChangedSize: false,
    
    state: {
        phase: 'SETUP', // SETUP, LOBBY, PLAYING, INTERMISSION, GAMEOVER
        roomCode: '',
        teamSize: 5,
        round: 1,
        timeLeft: CONFIG.ROUND_TIME,
        players: {}, // peerId -> { id, name, team, col, pos, alive, action, ready, connected, defending, proceeded }
        history: [],
        lastRoundEvents: [],
        winner: ''
    },

    myId: null,
    myName: '',
    selectedAction: null,

    init() {
        const savedName = localStorage.getItem('pc_name');
        if (savedName) document.getElementById('player-name').value = savedName;
    },

    showScreen(id) {
        document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
        document.getElementById(id).classList.add('active');
    },

    // Fixes Issue 2: Strictly numeric code generation algorithm
    generateRoomCode() {
        return Math.floor(10000 + Math.random() * 90000).toString();
    },

    async setupPeer(id) {
        return new Promise((resolve, reject) => {
            app.peer = new Peer(CONFIG.PEER_PREFIX + id);
            app.peer.on('open', resolve);
            app.peer.on('error', reject);
        });
    },

    // --- HOST AUTHORITATIVE ENGINE ---

    async hostGame() {
        const name = document.getElementById('player-name').value.trim().toUpperCase();
        if (!name) return app.showError("ENTER CODENAME");
        
        app.myName = name;
        localStorage.setItem('pc_name', name);
        app.isHost = true;
        app.hasManuallyChangedSize = false;
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
            } else if (data.type === 'PROCEED') {
                app.handleClientProceed(conn.peer);
            }
        });
        conn.on('close', () => {
            if (app.state.players[conn.peer]) {
                if (app.state.phase === 'LOBBY') {
                    delete app.state.players[conn.peer];
                    app.autoAdjustTeamSize();
                } else {
                    app.state.players[conn.peer].connected = false;
                }
            }
            app.connections = app.connections.filter(c => c !== conn);
            app.broadcastState();
        });
    },

    addPlayer(id, name) {
        app.addPlayerInternal(id, name);
        if (app.state.phase === 'LOBBY') {
            app.autoAdjustTeamSize();
        }
    },

    addPlayerInternal(id, name) {
        if (app.state.players[id]) {
            app.state.players[id].connected = true;
            app.state.players[id].name = name;
            return;
        }

        const currentPlayers = Object.values(app.state.players);
        const blueCount = currentPlayers.filter(p => p.team === 'BLUE').length;
        const redCount = currentPlayers.filter(p => p.team === 'RED').length;
        
        let assignedTeam = 'BLUE';
        if (blueCount < app.state.teamSize || redCount < app.state.teamSize) {
            if (blueCount <= redCount) {
                assignedTeam = blueCount < app.state.teamSize ? 'BLUE' : 'RED';
            } else {
                assignedTeam = redCount < app.state.teamSize ? 'RED' : 'BLUE';
            }
        } else {
            assignedTeam = blueCount <= redCount ? 'BLUE' : 'RED';
        }

        const teamPlayerCount = Object.values(app.state.players).filter(p => p.team === assignedTeam).length;
        const assignedColumn = teamPlayerCount + 1;

        app.state.players[id] = {
            id: id,
            name: name,
            team: assignedTeam,
            col: assignedColumn,
            pos: 'B',
            alive: true,
            action: null,
            ready: false,
            connected: true,
            defending: false,
            proceeded: false
        };
    },

    autoAdjustTeamSize() {
        if (!app.isHost || app.state.phase !== 'LOBBY' || app.hasManuallyChangedSize) return;
        const totalPlayers = Object.keys(app.state.players).length;
        
        const recommendedSize = Math.min(6, Math.max(1, Math.ceil(totalPlayers / 2)));
        app.state.teamSize = recommendedSize;
        
        const playersCache = Object.values(app.state.players);
        app.state.players = {};
        playersCache.forEach(p => app.addPlayerInternal(p.id, p.name));
        
        const selector = document.getElementById('team-size-select');
        if (selector) selector.value = recommendedSize;
    },

    changeTeamSize() {
        if (!app.isHost) return;
        app.hasManuallyChangedSize = true; 
        app.state.teamSize = parseInt(document.getElementById('team-size-select').value);
        
        const playersCache = Object.values(app.state.players);
        app.state.players = {};
        playersCache.forEach(p => app.addPlayerInternal(p.id, p.name));
        
        app.broadcastState();
    },

    // Fixes Issue 4: Match initiation verification check
    startGame() {
        if (!app.isHost) return;
        
        const totalCount = Object.keys(app.state.players).length;
        if (totalCount <= 1) {
            app.showLobbyError("MINIMUM 2 PLAYERS REQUIRED TO INITIATE DEPLOYMENT");
            return;
        }

        app.state.phase = 'PLAYING';
        app.state.round = 1;
        app.state.history = [];
        app.startRoundTimer();
        app.broadcastState();
        app.renderGame();
    },

    broadcastState() {
        if (!app.isHost) return;
        const statePayload = {
            type: 'STATE_UPDATE',
            state: JSON.parse(JSON.stringify(app.state))
        };
        app.connections.forEach(conn => conn.send(statePayload));
        app.processState(statePayload.state);
    },

    handleClientAction(id, actionData) {
        const p = app.state.players[id];
        if (!p || !p.alive || p.ready || app.state.phase !== 'PLAYING') return;
        
        p.action = actionData;
        p.ready = true;
        
        app.broadcastState();
        app.checkRoundReady();
    },

    handleClientProceed(id) {
        const p = app.state.players[id];
        if (!p || app.state.phase !== 'INTERMISSION') return;
        p.proceeded = true;
        
        const activePlayers = Object.values(app.state.players).filter(p => p.alive && p.connected);
        if (activePlayers.length > 0 && activePlayers.every(p => p.proceeded)) {
            clearInterval(app.timerInterval);
            app.state.phase = 'PLAYING';
            app.state.round++;
            app.startRoundTimer();
        }
        
        app.broadcastState();
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
        }, CONFIG.TICK_RATE);
    },

    startIntermissionTimer() {
        clearInterval(app.timerInterval);
        app.state.timeLeft = CONFIG.INTERMISSION_TIME;
        app.timerInterval = setInterval(() => {
            app.state.timeLeft--;
            if (app.state.timeLeft <= 0) {
                clearInterval(app.timerInterval);
                app.state.phase = 'PLAYING';
                app.state.round++;
                app.startRoundTimer();
            }
            app.broadcastState();
        }, CONFIG.TICK_RATE);
    },

    checkRoundReady() {
        const alivePlayers = Object.values(app.state.players).filter(p => p.alive && p.connected);
        if (alivePlayers.length > 0 && alivePlayers.every(p => p.ready)) {
            clearInterval(app.timerInterval);
            app.resolveRound();
        }
    },

    forceReadyAndResolve() {
        Object.values(app.state.players).forEach(p => {
            if (p.alive && !p.ready) {
                p.action = { type: 'defend' };
                p.ready = true;
            }
        });
        app.resolveRound();
    },

    openConfirmModal() {
        if (!app.isHost) return;
        document.getElementById('confirm-modal').classList.add('active');
    },

    closeConfirmModal() {
        document.getElementById('confirm-modal').classList.remove('active');
    },

    executeEndGame() {
        if (!app.isHost) return;
        clearInterval(app.timerInterval);
        app.closeConfirmModal();
        
        app.state.phase = 'GAMEOVER';
        app.state.winner = 'MISSION TERMINATED BY HOST';
        app.broadcastState();
    },

    // Fixes Issue 1: Absolute simultaneous calculation matrix eliminates chronological processing bugs
    resolveRound() {
        const players = app.state.players;
        const roundEvents = [];
        
        roundEvents.push(`<div class="log-round">ROUND ${app.state.round} RESOLUTION</div>`);

        // Phase 1: Move evaluation
        for (const id in players) {
            const p = players[id];
            p.defending = false;
            if (p.alive && p.action && p.action.type === 'move') {
                const oldPos = p.pos;
                p.pos = p.pos === 'A' ? 'B' : 'A';
                roundEvents.push(`<span class="log-event">${p.name} shifted grid coordinates (${oldPos}${p.col} &rarr; ${p.pos}${p.col})</span>`);
            }
        }

        // Phase 2: Defense registration
        for (const id in players) {
            const p = players[id];
            if (p.alive && p.action && p.action.type === 'defend') {
                p.defending = true;
            }
        }

        // Phase 3: Snapshot system records eligibility to allow fire if killed in this same iteration
        const aliveAtStartOfAttack = {};
        for (const id in players) {
            aliveAtStartOfAttack[id] = players[id].alive;
        }

        const registeredCasualties = new Set();

        // Phase 4: Attack computation based on target mapping status records
        for (const id in players) {
            const attacker = players[id];
            if (aliveAtStartOfAttack[id] && attacker.action && attacker.action.type === 'attack') {
                const targetCell = attacker.action.target;
                if (!targetCell) continue;
                
                const targetRow = targetCell.charAt(0);
                const targetCol = parseInt(targetCell.substring(1));
                
                const enemyTeam = attacker.team === 'BLUE' ? 'RED' : 'BLUE';
                const targetPlayer = Object.values(players).find(p => 
                    p.team === enemyTeam && p.col === targetCol && p.pos === targetRow && p.alive
                );

                if (!targetPlayer) {
                    roundEvents.push(`<span class="log-event miss">[MISS] ${attacker.name} broadsided cell ${targetCell}</span>`);
                } else if (targetPlayer.defending) {
                    roundEvents.push(`<span class="log-event blocked">[BLOCKED] ${attacker.name} struck ${targetCell} &rarr; Deflected by ${targetPlayer.name}</span>`);
                } else {
                    registeredCasualties.add(targetPlayer.id);
                    roundEvents.push(`<span class="log-event eliminated">[ELIMINATED] ${attacker.name} mapped critical hit on ${targetCell} &rarr; ${targetPlayer.name} down</span>`);
                }
            }
        }

        // Phase 5: Simultaneous application of life-status mutations
        registeredCasualties.forEach(targetId => {
            if (players[targetId]) players[targetId].alive = false;
        });

        app.state.lastRoundEvents = roundEvents;
        app.state.history.push(...roundEvents);

        // Reset tracking flags
        for (const id in players) {
            players[id].ready = false;
            players[id].action = null;
            players[id].proceeded = false; 
        }

        const blueAlive = Object.values(players).filter(p => p.team === 'BLUE' && p.alive).length > 0;
        const redAlive = Object.values(players).filter(p => p.team === 'RED' && p.alive).length > 0;

        if (!blueAlive || !redAlive) {
            app.state.phase = 'GAMEOVER';
            if (!blueAlive && !redAlive) {
                app.state.winner = 'MUTUAL ANNIHILATION - DRAW';
            } else {
                app.state.winner = blueAlive ? 'TEAM BLUE WINS' : 'TEAM RED WINS';
            }
            app.broadcastState();
        } else {
            app.state.phase = 'INTERMISSION';
            app.startIntermissionTimer();
            app.broadcastState();
        }
    },

    // --- CLIENT OPERATIONS ---

    async joinGame() {
        const name = document.getElementById('player-name').value.trim().toUpperCase();
        const code = document.getElementById('room-code-input').value.trim().toUpperCase();
        
        if (!name || !code) return app.showError("ENTER CODENAME AND ROOM CODE");
        
        app.myName = name;
        localStorage.setItem('pc_name', name);
        app.isHost = false;
        
        try {
            app.myId = await app.setupPeer(name + Math.random().toString(16).slice(2));
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
        
        const abortBtn = document.getElementById('host-abort-btn');
        if (app.isHost && (app.state.phase === 'PLAYING' || app.state.phase === 'INTERMISSION')) {
            abortBtn.style.display = 'block';
        } else {
            abortBtn.style.display = 'none';
        }

        if (app.state.phase === 'LOBBY') {
            app.showScreen('lobby-screen');
            app.renderLobby();
        } else if (app.state.phase === 'PLAYING') {
            document.getElementById('result-modal').classList.remove('active');
            
            if (!document.getElementById('game-screen').classList.contains('active')) {
                app.showScreen('game-screen');
            }
            app.renderGame();
        } else if (app.state.phase === 'INTERMISSION') {
            if (!document.getElementById('game-screen').classList.contains('active')) {
                app.showScreen('game-screen');
            }
            app.renderGame();
            
            const me = app.state.players[app.myId];
            if (me && !me.proceeded) {
                const modal = document.getElementById('result-modal');
                document.getElementById('modal-log').innerHTML = app.state.lastRoundEvents.join('');
                document.getElementById('modal-timer').innerText = app.state.timeLeft;
                modal.classList.add('active');
            } else {
                document.getElementById('result-modal').classList.remove('active');
            }
        } else if (app.state.phase === 'GAMEOVER') {
            document.getElementById('result-modal').classList.remove('active');
            app.showScreen('end-screen');
            document.getElementById('winner-text').innerText = app.state.winner;
            if (app.state.winner.includes('BLUE')) {
                document.getElementById('winner-text').style.color = 'var(--neon-blue)';
            } else if (app.state.winner.includes('RED')) {
                document.getElementById('winner-text').style.color = 'var(--neon-red)';
            } else {
                document.getElementById('winner-text').style.color = '#ffffff';
            }
        }
    },

    selectAction(type) {
        const me = app.state.players[app.myId];
        if (!me || !me.alive || me.ready || app.state.phase !== 'PLAYING') return;

        document.querySelectorAll('.act-btn').forEach(b => b.classList.remove('active-action'));
        document.getElementById(`btn-${type}`).classList.add('active-action');

        if (type === 'move' || type === 'defend') {
            app.selectedAction = { type: type };
            document.getElementById('action-status').innerText = `ORDERS LOCKED: ${type.toUpperCase()}`;
            app.renderGame();
        } else if (type === 'attack') {
            app.selectedAction = { type: 'attack', target: null };
            document.getElementById('action-status').innerText = `SELECT SCAN MATRIX CELL TARGET`;
            app.renderGame();
        }
    },

    selectTarget(cellId) {
        if (app.selectedAction && app.selectedAction.type === 'attack') {
            app.selectedAction.target = cellId;
            document.getElementById('action-status').innerText = `TARGET ACQUIRED: ${cellId}`;
            app.renderGame();
        }
    },

    submitReady() {
        const me = app.state.players[app.myId];
        if (!me || !me.alive || me.ready || app.state.phase !== 'PLAYING') return;

        if (!app.selectedAction) {
            app.showActionError("NO ACTION SELECTED");
            return;
        }

        if (app.selectedAction.type === 'attack' && !app.selectedAction.target) {
            app.showActionError("TARGET CONFIGURATION REQUIRED");
            return;
        }

        if (app.isHost) {
            app.handleClientAction(app.myId, app.selectedAction);
        } else {
            app.conn.send({ type: 'ACTION', action: app.selectedAction });
        }
        
        document.getElementById('action-status').innerText = "TRANSMITTING DATA...";
        document.getElementById('btn-ready').disabled = true;
    },

    submitProceed() {
        if (app.isHost) {
            app.handleClientProceed(app.myId);
        } else {
            app.conn.send({ type: 'PROCEED' });
        }
        document.getElementById('result-modal').classList.remove('active');
    },

    returnToBase() {
        if (app.peer) {
            app.peer.destroy();
        }
        window.location.href = window.location.pathname;
    },

    // --- DISPLAY RENDERING ---

    renderLobby() {
        const blueList = document.getElementById('blue-team-list');
        const redList = document.getElementById('red-team-list');
        blueList.innerHTML = '';
        redList.innerHTML = '';

        Object.values(app.state.players).forEach(p => {
            const li = document.createElement('li');
            li.innerText = `${p.name} (COL ${p.col})` + (!p.connected ? ' [OFFLINE]' : '');
            if (p.team === 'BLUE') blueList.appendChild(li);
            else if (p.team === 'RED') redList.appendChild(li);
        });
    },

    renderGame() {
        const me = app.state.players[app.myId] || { team: 'SPECTATOR', alive: false };
        
        document.getElementById('round-display').innerText = app.state.round;
        document.getElementById('timer-display').innerText = app.state.timeLeft;
        document.getElementById('alive-display').innerText = Object.values(app.state.players).filter(p=>p.alive).length;

        if (app.state.phase === 'INTERMISSION') {
            document.getElementById('modal-timer').innerText = app.state.timeLeft;
        }

        const cols = app.state.teamSize;
        const enemyGrid = document.getElementById('enemy-grid');
        const allyGrid = document.getElementById('ally-grid');
        
        enemyGrid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
        allyGrid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
        
        enemyGrid.innerHTML = '';
        allyGrid.innerHTML = '';

        ['A', 'B'].forEach(row => {
            for (let c = 1; c <= cols; c++) {
                const cellId = `${row}${c}`;
                
                const aCell = document.createElement('div');
                aCell.className = 'cell';
                aCell.id = `ally-${cellId}`;
                
                const labelA = document.createElement('span');
                labelA.className = 'cell-label';
                labelA.innerText = cellId;
                aCell.appendChild(labelA);

                const nameContainerA = document.createElement('span');
                nameContainerA.className = 'cell-name';

                const ally = Object.values(app.state.players).find(p => p.team === me.team && p.pos === row && p.col === c);
                if (ally) {
                    if (ally.alive) {
                        aCell.classList.add('ally-occupied');
                        nameContainerA.innerText = ally.id === app.myId ? `YOU (${ally.name})` : ally.name;
                    } else {
                        aCell.classList.add('dead');
                        nameContainerA.innerText = `[${ally.name}]`;
                    }
                } else {
                    nameContainerA.innerText = '';
                }
                aCell.appendChild(nameContainerA);
                allyGrid.appendChild(aCell);

                const eCell = document.createElement('div');
                eCell.className = 'cell';
                eCell.id = `enemy-${cellId}`;
                
                const labelE = document.createElement('span');
                labelE.className = 'cell-label';
                labelE.innerText = cellId;
                eCell.appendChild(labelE);

                const nameContainerE = document.createElement('span');
                nameContainerE.className = 'cell-name';

                const enemyTeam = me.team === 'BLUE' ? 'RED' : 'BLUE';
                const enemy = Object.values(app.state.players).find(p => p.team === enemyTeam && p.pos === row && p.col === c);
                
                if (enemy && !enemy.alive) {
                    eCell.classList.add('dead', 'enemy-occupied');
                    nameContainerE.innerText = `[${enemy.name}]`;
                } else {
                    nameContainerE.innerText = '?';
                    if (me.alive && !me.ready && app.state.phase === 'PLAYING' && app.selectedAction && app.selectedAction.type === 'attack') {
                        eCell.classList.add('selectable');
                        eCell.onclick = () => app.selectTarget(cellId);
                        if (app.selectedAction.target === cellId) {
                            eCell.classList.add('targeted');
                        }
                    }
                }
                eCell.appendChild(nameContainerE);
                enemyGrid.appendChild(eCell);
            }
        });

        const readyBtn = document.getElementById('btn-ready');
        if (!me.alive || app.state.phase !== 'PLAYING') {
            if (!me.alive) document.getElementById('action-status').innerText = "SPECTATING RADAR MATRIX";
            readyBtn.disabled = true;
            document.querySelectorAll('.act-btn').forEach(b => b.disabled = true);
        } else if (me.ready) {
            readyBtn.disabled = true;
            document.querySelectorAll('.act-btn').forEach(b => b.disabled = true);
        } else {
            readyBtn.disabled = false;
            document.querySelectorAll('.act-btn').forEach(b => b.disabled = false);
        }

        const log = document.getElementById('history-log');
        log.innerHTML = app.state.history.map(item => `<div>${item}</div>`).join('');
        log.scrollTop = log.scrollHeight;
    },

    showError(msg) {
        document.getElementById('setup-error').innerText = msg;
        setTimeout(() => document.getElementById('setup-error').innerText = '', 3000);
    },

    showLobbyError(msg) {
        document.getElementById('lobby-error').innerText = msg;
        setTimeout(() => document.getElementById('lobby-error').innerText = '', 4000);
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