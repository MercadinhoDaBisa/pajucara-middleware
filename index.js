require('dotenv').config(); // Carrega variáveis de ambiente do arquivo .env
const express = require('express'); // Framework web para Node.js
const axios = require('axios'); // Cliente HTTP para fazer requisições (para a SSW)
const crypto = require('crypto'); // Módulo nativo do Node.js para operações criptográficas (HMAC)

const app = express(); // Inicializa o aplicativo Express

// Middleware para obter o corpo bruto da requisição ANTES de ser parseado como JSON.
app.use(express.raw({ type: 'application/json' }));
app.use(express.json());

const YAMPI_SECRET_TOKEN = process.env.YAMPI_SECRET_TOKEN;
const SSW_LOGIN = process.env.SSW_LOGIN; // Variável para o login da SSW
const SSW_PASSWORD = process.env.SSW_PASSWORD; // Variável para a senha da SSW
const SSW_DOMAIN = process.env.SSW_DOMAIN; // NOVA VARIÁVEL: Para o domínio da SSW (PAJ)
const SSW_CNPJ = process.env.SSW_CNPJ; // Variável para o CNPJ da SSW

app.post('/cotacao', async (req, res) => {
    console.log('Todos os Headers Recebidos:', req.headers); // Log para depuração

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
    try {
        const hmac = crypto.createHmac('sha256', YAMPI_SECRET_TOKEN);
        const parsedBody = JSON.parse(requestBodyRaw.toString('utf8'));
        const normalizedBodyString = JSON.stringify(parsedBody);

        hmac.update(normalizedBodyString);
        calculatedSignature = hmac.digest('base64');
    } catch (error) {
        console.error('Erro ao calcular a assinatura HMAC:', error.message);
        return res.status(500).json({ error: 'Erro interno na validação de segurança.' });
    }

    console.log('Assinatura Calculada:', calculatedSignature);
    console.log('Assinaturas são iguais?', calculatedSignature === yampiSignature);

    if (calculatedSignature !== yampiSignature) {
        console.error('Erro de Segurança: Assinatura Yampi inválida. Calculada:', calculatedSignature, 'Recebida:', yampiSignature);
        return res.status(401).json({ error: 'Acesso não autorizado. Assinatura Yampi inválida.' });
    }

    console.log('Validação de segurança Yampi: SUCESSO!');

    try {
        const yampiData = JSON.parse(requestBodyRaw.toString('utf8'));
        console.log('Payload Yampi Recebido:', JSON.stringify(yampiData, null, 2));

        const cepOrigem = '30720404'; // CEP fixo de origem
        const cepDestino = yampiData.zipcode ? yampiData.zipcode.replace(/\D/g, '') : null;
        const valorDeclarado = yampiData.amount || 0;
        const cnpjCpfDestinatario = yampiData.cart && yampiData.cart.customer ? yampiData.cart.customer.document : null;

        let pesoTotal = 0;
        let cubagemTotal = 0;
        let qtdeVolumeTotal = 0;

        if (yampiData.skus && Array.isArray(yampiData.skus)) {
            yampiData.skus.forEach(sku => {
                const pesoItem = sku.weight || 0;
                const quantidadeItem = sku.quantity || 1;
                const comprimento = sku.length || 0;
                const largura = sku.width || 0;
                const altura = sku.height || 0;

                pesoTotal += pesoItem * quantidadeItem;
                cubagemTotal += (comprimento * largura * altura / 1000000) * quantidadeItem; // Convertendo cm³ para m³
                qtdeVolumeTotal += quantidadeItem;
            });
        }

        // Requisição para SSW
        const sswRequestData = (tpServico) => ({
            param: {
                "Chave": SSW_DOMAIN, // AGORA LENDO DA VARIÁVEL DE AMBIENTE
                "CNPJ": SSW_CNPJ,
                "Login": SSW_LOGIN,
                "Senha": SSW_PASSWORD
            },
            filtro: {
                "tpServico": tpServico, // 1 para Rodoviário, 2 para Aéreo
                "tpCobranca": "C", // C = CIF (pago pelo emitente)
                "cepOrigem": cepOrigem,
                "cepDestino": cepDestino,
                "cnpjCpfDestinatario": cnpjCpfDestinatario,
                "retira": "N", // N = Entrega
                "peso": pesoTotal,
                "cubagem": cubagemTotal,
                "valorNota": valorDeclarado,
                "qtdeVolume": qtdeVolumeTotal
            }
        });

        // Tentar cotação Rodoviária (tpServico: 1)
        let rodoviarioResult = null;
        try {
            const payloadRodoviario = sswRequestData("1");
            console.log('Payload SSW (Rodoviário) Enviado:', JSON.stringify(payloadRodoviario, null, 2));
            const responseRodoviario = await axios.post('https://ssw.inf.br/sswservice/services/sswservice?wsdl', payloadRodoviario); // Verifique essa URL com a SSW
            rodoviarioResult = responseRodoviario.data;
            console.log('Resposta Bruta SSW (Rodoviário):', JSON.stringify(rodoviarioResult, null, 2));
        } catch (error) {
            console.error('Erro na requisição SSW (Rodoviário):', error.message);
            if (error.response && error.response.data) {
                console.error('Detalhes do erro da SSW:', error.response.data);
            }
        }

        // Tentar cotação Aérea (tpServico: 2)
        let aereoResult = null;
        try {
            const payloadAereo = sswRequestData("2");
            console.log('Payload SSW (Aéreo) Enviado:', JSON.stringify(payloadAereo, null, 2));
            const responseAereo = await axios.post('https://ssw.inf.br/sswservice/services/sswservice?wsdl', payloadAereo); // Verifique essa URL com a SSW
            aereoResult = responseAereo.data;
            console.log('Resposta Bruta SSW (Aéreo):', JSON.stringify(aereoResult, null, 2));
        } catch (error) {
            console.error('Erro na requisição SSW (Aéreo):', error.message);
            if (error.response && error.response.data) {
                console.error('Detalhes do erro da SSW:', error.response.data);
            }
        }

        const quotes = [];

        // Processar resultado Rodoviário
        if (rodoviarioResult && rodoviarioResult.retorno && rodoviarioResult.retorno.CustoFrete && rodoviarioResult.retorno.CustoFrete.Valor) {
            quotes.push({
                "name": "Pajuçara Rodoviário",
                "service": "Pajucara_Rodoviario",
                "price": rodoviarioResult.retorno.CustoFrete.Valor,
                "days": rodoviarioResult.retorno.Prazo || 0,
                "quote_id": "rodoviario"
            });
        }

        // Processar resultado Aéreo
        if (aereoResult && aereoResult.retorno && aereoResult.retorno.CustoFrete && aereoResult.retorno.CustoFrete.Valor) {
            quotes.push({
                "name": "Pajuçara Aéreo",
                "service": "Pajucara_Aereo",
                "price": aereoResult.retorno.CustoFrete.Valor,
                "days": aereoResult.retorno.Prazo || 0,
                "quote_id": "aereo"
            });
        }

        const finalResponse = {
            "quotes": quotes
        };

        console.log('Resposta FINAL enviada para Yampi:', JSON.stringify(finalResponse, null, 2));
        res.json(finalResponse);

    } catch (error) {
        console.error('Erro no processamento da requisição Yampi ou SSW:', error.message);
        return res.status(500).json({ error: 'Erro interno no servidor de cotação.' });
    }
});

app.get('/', (req, res) => {
    res.send('Middleware da Pajuçara rodando');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));