const { Server } = require('socket.io');

let io;

// Map to track online members: memberId -> Set of socket IDs
const onlineMembers = new Map();
// Map to track socket ID to member info
const socketToMember = new Map();

function initWebSockets(server) {
    io = new Server(server, {
        cors: {
            origin: '*',
            methods: ['GET', 'POST']
        }
    });

    io.on('connection', (socket) => {
        console.log(`🔌 Novo dispositivo conectado (Socket ID: ${socket.id})`);

        socket.on('join_family', (data) => {
            // Data can be just familyId (string) or an object { familyId, memberId }
            let familyId, memberId;
            if (typeof data === 'object' && data !== null) {
                familyId = data.familyId;
                memberId = data.memberId;
            } else {
                familyId = data;
            }

            const roomName = `family_${familyId}`;
            socket.join(roomName);
            console.log(`🏠 Dispositivo ${socket.id} entrou na sala: ${roomName}`);

            if (memberId) {
                socketToMember.set(socket.id, { familyId, memberId });
                
                let wasOffline = false;
                if (!onlineMembers.has(memberId)) {
                    onlineMembers.set(memberId, new Set());
                    wasOffline = true;
                }
                
                const memberSockets = onlineMembers.get(memberId);
                // Se esse socket já estava na lista, não faz nada
                if (!memberSockets.has(socket.id)) {
                    memberSockets.add(socket.id);
                    // Só emite se ele estava offline antes
                    if (wasOffline) {
                        // Broadcast para a família que o membro ficou online
                        io.to(roomName).emit('member_status_changed', {
                            memberId,
                            isOnline: true
                        });
                    }
                }
            }
        });

        socket.on('new_transaction', (transactionData) => {
            console.log('💰 Nova transação recebida:', transactionData);
            io.to(`family_${transactionData.familyId}`).emit('data_updated', {
                message: 'Um membro acabou de registrar um gasto/receita!',
                data: transactionData,
                source: 'transactions'
            });
        });

        socket.on('disconnect', () => {
            console.log(`🔌 Dispositivo desconectado (Socket ID: ${socket.id})`);
            
            const memberInfo = socketToMember.get(socket.id);
            if (memberInfo) {
                const { familyId, memberId } = memberInfo;
                const memberSockets = onlineMembers.get(memberId);
                
                if (memberSockets) {
                    memberSockets.delete(socket.id);
                    if (memberSockets.size === 0) {
                        onlineMembers.delete(memberId);
                        
                        // Broadcast para a família que o membro ficou offline
                        io.to(`family_${familyId}`).emit('member_status_changed', {
                            memberId,
                            isOnline: false
                        });
                    }
                }
                socketToMember.delete(socket.id);
            }
        });
    });

    return io;
}

function getIo() {
    if (!io) {
        throw new Error("WebSockets (Socket.io) não inicializado!");
    }
    return io;
}

function isMemberOnline(memberId) {
    return onlineMembers.has(memberId.toString());
}

module.exports = { initWebSockets, getIo, isMemberOnline };