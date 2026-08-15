#!/usr/bin/env node
/**
 * Confere se o commit que está no HEAD local já está rodando de verdade na API
 * de produção — mesmo espírito da validação de deploy do front (scripts/deploy.js
 * na raiz do projeto), usando o /version.json do backend.
 *
 * Não basta o git push ter dado certo: esse servidor roda via deploy externo
 * (Hostinger), e nada aqui garante que ele puxa e reinicia sozinho a cada push.
 * Esse script é o jeito de confirmar isso de fora, sem precisar acessar o painel.
 *
 * Uso: npm run verify-deploy
 */
const { execSync } = require('child_process');
const https = require('https');

const API_VERSION_URL = 'https://gestao-mob-api.dephix.com.br/version.json';

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error(`Resposta não era JSON válido (status ${res.statusCode}): ${data.slice(0, 200)}`));
                }
            });
        }).on('error', reject);
    });
}

async function verify(expectedCommit, attempts = 5, delayMs = 3000) {
    for (let i = 1; i <= attempts; i++) {
        try {
            const live = await fetchJson(`${API_VERSION_URL}?v=${Date.now()}-${i}`);
            if (live.commit === expectedCommit) {
                console.log(`✅ Confirmado no ar: commit ${live.commit_short} (servidor de pé desde ${live.server_started_at}) — tentativa ${i}/${attempts}`);
                return true;
            }
            console.log(`⏳ API ainda respondendo commit ${live.commit_short || live.commit} (esperado ${expectedCommit.substring(0, 7)}) — tentativa ${i}/${attempts}`);
        } catch (e) {
            console.log(`⏳ Falha ao consultar ${API_VERSION_URL}: ${e.message} — tentativa ${i}/${attempts}`);
        }
        if (i < attempts) await new Promise((r) => setTimeout(r, delayMs));
    }
    return false;
}

async function main() {
    const localCommit = execSync('git rev-parse HEAD').toString().trim();
    console.log(`🔍 Commit local (HEAD): ${localCommit.substring(0, 7)}`);
    console.log(`🔍 Consultando ${API_VERSION_URL}...`);

    const ok = await verify(localCommit);

    if (ok) {
        console.log('\n✅ Backend confirmado no ar com o commit mais recente.');
    } else {
        console.log('\n⚠️  A API ainda NÃO está servindo o commit local — provavelmente falta um passo de redeploy manual no Hostinger (git pull + restart do processo).');
        process.exitCode = 1;
    }
}

main().catch((e) => {
    console.error('Erro:', e.message);
    process.exit(1);
});
