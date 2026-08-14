const { forceUpdateAICache } = require('../controllers/walletController');

// Mapeia familyId para o timeout atual do debounce
const debounceTimers = new Map();

/**
 * Aciona uma atualização em background da IA para a família fornecida,
 * aplicando um debounce de 10 segundos.
 * @param {number} familyId 
 */
function triggerUpdate(familyId) {
    if (!familyId) return;

    // Se já existe um timer rolando para essa família, cancelamos ele (debounce)
    if (debounceTimers.has(familyId)) {
        clearTimeout(debounceTimers.get(familyId));
    }

    // Criamos um novo timer para daqui 5 minutos (300000 ms)
    // Se novas requisições chegarem antes de 5 min, o timer será resetado.
    console.log(`⏱️ [Background AI] Atualização agendada para família ${familyId} em 5 minutos.`);
    const timer = setTimeout(async () => {
        try {
            console.log(`⏳ [Background AI] Iniciando recalculo para a família ${familyId}...`);
            await forceUpdateAICache(familyId);
            console.log(`✅ [Background AI] Recalculo finalizado para a família ${familyId}.`);
        } catch (error) {
            console.error(`❌ [Background AI] Erro ao recalcular para a família ${familyId}:`, error);
        } finally {
            // Limpa do map após finalizar
            debounceTimers.delete(familyId);
        }
    }, 300000);

    debounceTimers.set(familyId, timer);
    console.log(`⏱️ [Background AI] Atualização agendada para família ${familyId} em 5 minutos.`);
}

module.exports = {
    triggerUpdate
};
