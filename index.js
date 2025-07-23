require('dotenv').config(); // Carrega variáveis de ambiente do arquivo .env
const express = require('express'); // Framework web para Node.js
const axios = require('axios'); // Cliente HTTP para fazer requisições (para a Jadlog e SSW)
const https = require('https'); // Módulo HTTPS para configurar o agente (se rejectUnauthorized for false)
const crypto = require('crypto'); // Módulo nativo do Node.js para operações criptográficas (HMAC)

const app = express(); // Inicializa o aplicativo Express

// Middleware para obter o corpo bruto da requisição ANTES de ser parseado como JSON.
app.use(express.raw({ type: 'application/json' }));
app.use(express.json());

// Agente HTTPS para lidar com certificados SSL (se necessário)
const agent = new https.Agent({
    rejectUnauthorized: false
});

// --- Variáveis de Ambiente Comuns/Yampi ---
const YAMPI_SECRET_TOKEN = process.env.YAMPI_SECRET_TOKEN;

// --- Variáveis de Ambiente Jadlog ---
const JADLOG_TOKEN = process.env.JADLOG_TOKEN;
const JADLOG_CNPJ = process.env.JADLOG_CNPJ;
const JADLOG_ACCOUNT = process.env.JADLOG_ACCOUNT;

// --- Variáveis de Ambiente Pajuçara (SSW) ---
const SSW_LOGIN = process.env.SSW_LOGIN;
const SSW_PASSWORD = process.env.SSW_PASSWORD;
const SSW_DOMAIN = process.env.SSW_DOMAIN;
const SSW_CNPJ = process.env.SSW_CNPJ;


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

        const cepOrigemFixo = "30720404"; // CEP fixo de origem para Jadlog e Pajuçara
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

        const opcoesFrete = [];

        // --- Cotação Jadlog ---
        try {
            const modalidadesDesejadasJadlog = [3, 5]; // 3 para Package, 5 para Econômico
            const freteRequestsJadlog = modalidadesDesejadasJadlog.map(modalidade => ({
                cepori: cepOrigemFixo,
                cepdes: cepDestino,
                frap: null,
                peso: pesoTotal,
                cnpj: JADLOG_CNPJ, // AGORA LENDO DA VARIÁVEL DE AMBIENTE
                conta: JADLOG_ACCOUNT,
                contrato: null,
                modalidade: modalidade,
                tpentrega: "D",
                tpseguro: "N",
                vldeclarado: valorDeclarado,
                vlcoleta: 0
            }));

            const payloadCotacaoJadlog = {
                frete: freteRequestsJadlog
            };

            console.log('Payload Jadlog Enviado:', JSON.stringify(payloadCotacaoJadlog, null, 2));

            const respostaJadlog = await axios.post(
                'https://www.jadlog.com.br/embarcador/api/frete/valor',
                payloadCotacaoJadlog,
                {
                    headers: {
                        Authorization: `Bearer ${JADLOG_TOKEN}`,
                        'Content-Type': 'application/json'
                    },
                    httpsAgent: agent
                }
            );

            console.log('Resposta Bruta da Jadlog:', JSON.stringify(respostaJadlog.data, null, 2));

            if (respostaJadlog.data && Array.isArray(respostaJadlog.data.frete) && respostaJadlog.data.frete.length > 0) {
                respostaJadlog.data.frete.forEach(frete => {
                    let nomeModalidade = "Jadlog Padrão";
                    let serviceModalidade = "Jadlog";

                    switch (frete.modalidade) {
                        case 3:
                            nomeModalidade = "Jadlog Package";
                            serviceModalidade = "Jadlog Package";
                            break;
                        case 5:
                            nomeModalidade = "Jadlog Econômico";
                            serviceModalidade = "Jadlog Economico";
                            break;
                        default:
                            nomeModalidade = `Jadlog (Mod. ${frete.modalidade})`;
                            serviceModalidade = `Jadlog ${frete.modalidade}`;
                    }

                    opcoesFrete.push({
                        "name": nomeModalidade,
                        "service": serviceModalidade,
                        "price": frete.vltotal || 0,
                        "days": frete.prazo || 0,
                        "quote_id": `jadlog_${frete.modalidade}`
                    });
                });
            } else {
                console.warn('Resposta da Jadlog não contém fretes no formato esperado ou está vazia:', respostaJadlog.data);
            }

        } catch (erro) {
            console.error('Erro na requisição Jadlog ou processamento:', erro.message);
            if (erro.response && erro.response.data) {
                console.error('Detalhes do erro da Jadlog:', erro.response.data);
            }
            // Não retorna erro aqui para continuar com a cotação da Pajuçara
        }


        // --- Cotação Pajuçara (SSW) ---
        try {
            // Requisição para SSW Rodoviária
            const payloadRodoviarioSSW = {
                param: {
                    "Chave": SSW_DOMAIN, // Lendo da variável de ambiente
                    "CNPJ": SSW_CNPJ,
                    "Login": SSW_LOGIN,
                    "Senha": SSW_PASSWORD
                },
                filtro: {
                    "tpServico": "1", // Rodoviário
                    "tpCobranca": "C",
                    "cepOrigem": cepOrigemFixo,
                    "cepDestino": cepDestino,
                    "cnpjCpfDestinatario": cnpjCpfDestinatario,
                    "retira": "N",
                    "peso": pesoTotal,
                    "cubagem": cubagemTotal,
                    "valorNota": valorDeclarado,
                    "qtdeVolume": qtdeVolumeTotal
                }
            };
            console.log('Payload SSW (Rodoviário) Enviado:', JSON.stringify(payloadRodoviarioSSW, null, 2));
            const responseRodoviarioSSW = await axios.post('https://ssw.inf.br/sswservice/services/sswservice?wsdl', payloadRodoviarioSSW); // Verifique essa URL com a SSW
            const rodoviarioResultSSW = responseRodoviarioSSW.data;
            console.log('Resposta Bruta SSW (Rodoviário):', JSON.stringify(rodoviarioResultSSW, null, 2));

            if (rodoviarioResultSSW && rodoviarioResultSSW.retorno && rodoviarioResultSSW.retorno.CustoFrete && rodoviarioResultSSW.retorno.CustoFrete.Valor) {
                opcoesFrete.push({
                    "name": "Pajuçara Rodoviário",
                    "service": "Pajucara_Rodoviario",
                    "price": rodoviarioResultSSW.retorno.CustoFrete.Valor,
                    "days": rodoviarioResultSSW.retorno.Prazo || 0,
                    "quote_id": "pajucara_rodoviario"
                });
            }

            // Requisição para SSW Aérea
            const payloadAereoSSW = {
                param: {
                    "Chave": SSW_DOMAIN, // Lendo da variável de ambiente
                    "CNPJ": SSW_CNPJ,
                    "Login": SSW_LOGIN,
                    "Senha": SSW_PASSWORD
                },
                filtro: {
                    "tpServico": "2", // Aéreo
                    "tpCobranca": "C",
                    "cepOrigem": cepOrigemFixo,
                    "cepDestino": cepDestino,
                    "cnpjCpfDestinatario": cnpjCpfDestinatario,
                    "retira": "N",
                    "peso": pesoTotal,
                    "cubagem": cubagemTotal,
                    "valorNota": valorDeclarado,
                    "qtdeVolume": qtdeVolumeTotal
                }
            };
            console.log('Payload SSW (Aéreo) Enviado:', JSON.stringify(payloadAereoSSW, null, 2));
            const responseAereoSSW = await axios.post('https://ssw.inf.br/sswservice/services/sswservice?wsdl', payloadAereoSSW); // Verifique essa URL com a SSW
            const aereoResultSSW = responseAereoSSW.data;
            console.log('Resposta Bruta SSW (Aéreo):', JSON.stringify(aereoResultSSW, null, 2));

            if (aereoResultSSW && aereoResultSSW.retorno && aereoResultSSW.retorno.CustoFrete && aereoResultSSW.retorno.CustoFrete.Valor) {
                opcoesFrete.push({
                    "name": "Pajuçara Aéreo",
                    "service": "Pajucara_Aereo",
                    "price": aereoResultSSW.retorno.CustoFrete.Valor,
                    "days": aereoResultSSW.retorno.Prazo || 0,
                    "quote_id": "pajucara_aereo"
                });
            }

        } catch (error) {
            console.error('Erro na requisição SSW (Pajuçara) ou processamento:', error.message);
            if (error.response && error.response.data) {
                console.error('Detalhes do erro da SSW:', error.response.data);
            }
            // Não retorna erro aqui para continuar processando outras cotações
        }

        const respostaFinalYampi = {
            "quotes": opcoesFrete
        };

        console.log('Resposta FINAL enviada para Yampi:', JSON.stringify(respostaFinalYampi, null, 2));

        res.json(respostaFinalYampi);

    } catch (erro) {
        console.error('Erro geral no processamento do webhook:', erro.message);
        return res.status(500).json({ erro: 'Erro interno no servidor de cotação.' });
    }
});

app.get('/', (req, res) => {
    res.send('Middleware de Cotação de Frete rodando (Jadlog e Pajuçara)');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));