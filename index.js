require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

const app = express();

app.use(express.raw({ type: 'application/json' }));

const YAMPI_SECRET_TOKEN = process.env.YAMPI_SECRET_TOKEN;

app.post('/cotacao', async (req, res) => {
    console.log('Headers Recebidos:', req.headers);

    const yampiSignature = req.headers['x-yampi-hmac-sha256'];
    const requestBodyRaw = req.body;

    console.log('--- DIAGNÓSTICO DE SEGURANÇA YAMPI ---');
    console.log('Assinatura Yampi recebida (X-Yampi-Hmac-SHA256):', yampiSignature);
    console.log('Chave Secreta Yampi (YAMPI_SECRET_TOKEN do .env/Render):', YAMPI_SECRET_TOKEN);
    console.log('Tipo da Assinatura recebida:', typeof yampiSignature);
    console.log('Tipo da Chave Secreta:', typeof YAMPI_SECRET_TOKEN);

    if (!yampiSignature || !YAMPI_SECRET_TOKEN) {
        console.error('Erro de Segurança: Assinatura Yampi ou Chave Secreta ausente.');
        return res.status(401).json({ error: 'Acesso não autorizado. Assinatura ou Chave Secreta Yampi ausente.' });
    }

    let calculatedSignature;
    let yampiData;
    try {
        const hmac = crypto.createHmac('sha256', YAMPI_SECRET_TOKEN);
        yampiData = JSON.parse(requestBodyRaw.toString('utf8'));
        const normalizedBodyString = JSON.stringify(yampiData);

        hmac.update(normalizedBodyString);
        calculatedSignature = hmac.digest('base64');
    } catch (error) {
        console.error('Erro ao calcular a assinatura HMAC ou parsear Yampi payload:', error.message);
        return res.status(500).json({ error: 'Erro interno na validação de segurança ou processamento do payload Yampi.' });
    }

    console.log('Assinatura Calculada:', calculatedSignature);
    console.log('Assinaturas são iguais?', calculatedSignature === yampiSignature);

    if (calculatedSignature !== yampiSignature) {
        console.error('Erro de Segurança: Assinatura Yampi inválida. Calculada:', calculatedSignature, 'Recebida:', yampiSignature);
        return res.status(401).json({ error: 'Acesso não autorizado. Assinatura Yampi inválida.' });
    }

    console.log('Validação de segurança Yampi: SUCESSO!');
    console.log('Payload Yampi Recebido:', JSON.stringify(yampiData, null, 2));


    try {
        const opcoesFrete = [];

        // --- CÓDIGO DE TESTE: Retornando valores fixos para a Yampi ---
        console.log('--- EXECUTANDO MODO DE TESTE: RETORNANDO VALORES FIXOS ---');

        // IMPORTANTE: O "name" DEVE SER O NOME QUE APARECE NO CHECKOUT OU O NOME DA SUA API NA YAMPI.
        // O "service" é o identificador interno. Vamos simplificar para ver se a Yampi tem restrição.
        opcoesFrete.push({
            "name": "Pajuçara Rodoviário", // Nome que você quer que apareça ou o nome da sua API
            "service": "RODOVIARIO",      // <<< Mudei aqui!
            "price": 25.00,
            "days": 5,
            "quote_id": "pajucara_teste_rodoviario_fixo"
        });

        opcoesFrete.push({
            "name": "Pajuçara Aéreo", // Nome que você quer que apareça ou o nome da sua API
            "service": "AEREO",         // <<< Mudei aqui!
            "price": 35.00,
            "days": 3,
            "quote_id": "pajucara_teste_aereo_fixo"
        });

        // --- FIM DO CÓDIGO DE TESTE ---


        const respostaFinalYampi = {
            "quotes": opcoesFrete
        };

        console.log('Resposta FINAL enviada para Yampi (TESTE FIXO):', JSON.stringify(respostaFinalYampi, null, 2));

        res.json(respostaFinalYampi);

    } catch (erro) {
        console.error('Erro geral no processamento do webhook:', erro.message);
        return res.status(500).json({ erro: 'Erro interno no servidor de cotação.' });
    }
});

app.get('/', (req, res) => {
    res.send('Middleware da Pajuçara rodando (Modo de Teste)');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));