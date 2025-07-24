require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const { create } = require('xmlbuilder2');
const xml2js = require('xml2js');

const app = express();

app.use(express.raw({ type: 'application/json' }));

const YAMPI_SECRET_TOKEN = process.env.YAMPI_SECRET_TOKEN;
const SSW_LOGIN = process.env.SSW_LOGIN;
const SSW_PASSWORD = process.env.SSW_PASSWORD;
const SSW_DOMAIN = process.env.SSW_DOMAIN;
const SSW_CNPJ = process.env.SSW_CNPJ;
const SSW_PAGADOR_PASSWORD = process.env.SSW_PAGADOR_PASSWORD || process.env.SSW_PASSWORD;

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
        const cepOrigemFixo = "30720404";
        const cepDestino = yampiData.zipcode ? yampiData.zipcode.replace(/\D/g, '') : null;
        const valorDeclarado = yampiData.amount || 0;
        // >>> MODIFICAÇÃO AQUI: Adiciona CNPJ padrão se não houver documento
        const cnpjCpfDestinatario = yampiData.cart && yampiData.cart.customer && yampiData.cart.customer.document
            ? yampiData.cart.customer.document.replace(/\D/g, '')
            : "00000000000100"; // CNPJ genérico para teste se não houver

        let pesoTotal = 0;
        let cubagemTotal = 0;
        let qtdeVolumeTotal = 0;
        let primeiroSkuDimensao = { length: 0, width: 0, height: 0 }; // Para pegar as dimensões do primeiro item

        if (yampiData.skus && Array.isArray(yampiData.skus)) {
            yampiData.skus.forEach((sku, index) => { // Adiciona index para pegar o primeiro
                const pesoItem = sku.weight || 0;
                const quantidadeItem = sku.quantity || 1;
                const comprimento = sku.length || 0;
                const largura = sku.width || 0;
                const altura = sku.height || 0;

                pesoTotal += pesoItem * quantidadeItem;
                cubagemTotal += (comprimento * largura * altura / 1000000) * quantidadeItem;
                qtdeVolumeTotal += quantidadeItem;

                if (index === 0) { // Armazena as dimensões do primeiro SKU
                    primeiroSkuDimensao = { length: comprimento, width: largura, height: altura };
                }
            });
        }

        const opcoesFrete = [];

        const sswApiUrl = 'https://ssw.inf.br/ws/sswCotacaoColeta/index.php';
        const sswSoapAction = 'urn:sswinfbr.sswCotacaoColeta#cotarSite';

        const createSoapEnvelope = (methodParams) => {
            const root = create({ version: '1.0', encoding: 'utf-8' })
                .ele('SOAP-ENV:Envelope', {
                    'xmlns:SOAP-ENV': 'http://schemas.xmlsoap.org/soap/envelope/',
                    'xmlns:xsd': 'http://www.w3.org/2001/XMLSchema',
                    'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
                    'xmlns:SOAP-ENC': 'http://schemas.xmlsoap.org/soap/encoding/',
                    'xmlns:tns': 'urn:sswinfbr.sswCotacaoColeta'
                })
                .ele('SOAP-ENV:Body', { 'SOAP-ENV:encodingStyle': 'http://schemas.xmlsoap.org/soap/encoding/' })
                    .ele('tns:cotarSite')
                        .ele('dominio', { 'xsi:type': 'xsd:string' }).txt(SSW_DOMAIN).up()
                        .ele('login', { 'xsi:type': 'xsd:string' }).txt(SSW_LOGIN).up()
                        .ele('senha', { 'xsi:type': 'xsd:string' }).txt(SSW_PASSWORD).up()
                        .ele('cnpjPagador', { 'xsi:type': 'xsd:string' }).txt(SSW_CNPJ).up()
                        .ele('senhaPagador', { 'xsi:type': 'xsd:string' }).txt(SSW_PAGADOR_PASSWORD).up()
                        .ele('cepOrigem', { 'xsi:type': 'xsd:integer' }).txt(parseInt(cepOrigemFixo)).up()
                        .ele('cepDestino', { 'xsi:type': 'xsd:integer' }).txt(parseInt(cepDestino)).up()
                        .ele('valorNF', { 'xsi:type': 'xsd:decimal' }).txt(valorDeclarado.toFixed(2)).up()
                        .ele('quantidade', { 'xsi:type': 'xsd:integer' }).txt(qtdeVolumeTotal).up()
                        .ele('peso', { 'xsi:type': 'xsd:decimal' }).txt(pesoTotal.toFixed(3)).up()
                        .ele('volume', { 'xsi:type': 'xsd:decimal' }).txt(cubagemTotal.toFixed(6)).up()
                        .ele('mercadoria', { 'xsi:type': 'xsd:integer' }).txt(methodParams.mercadoria || 1).up()
                        .ele('ciffob', { 'xsi:type': 'xsd:string' }).txt(methodParams.ciffob || 'C').up()
                        .ele('cnpjRemetente', { 'xsi:type': 'xsd:string' }).txt(SSW_CNPJ).up()
                        // >>> MODIFICAÇÃO AQUI: Usa o CNPJ do cliente ou o padrão
                        .ele('cnpjDestinatario', { 'xsi:type': 'xsd:string' }).txt(cnpjCpfDestinatario).up()
                        .ele('observacao', { 'xsi:type': 'xsd:string' }).txt('').up()
                        .ele('trt', { 'xsi:type': 'xsd:string' }).txt(methodParams.trt || 'N').up()
                        .ele('coletar', { 'xsi:type': 'xsd:string' }).txt(methodParams.coletar || 'N').up()
                        .ele('entDificil', { 'xsi:type': 'xsd:string' }).txt(methodParams.entDificil || 'N').up()
                        .ele('destContribuinte', { 'xsi:type': 'xsd:string' }).txt(methodParams.destContribuinte || 'N').up()
                        .ele('qtdePares', { 'xsi:type': 'xsd:integer' }).txt('0').up()
                        // >>> MODIFICAÇÃO AQUI: Tenta enviar as dimensões reais, em metros
                        .ele('altura', { 'xsi:type': 'xsd:decimal' }).txt((primeiroSkuDimensao.height / 100).toFixed(2)).up()
                        .ele('largura', { 'xsi:type': 'xsd:decimal' }).txt((primeiroSkuDimensao.width / 100).toFixed(2)).up()
                        .ele('comprimento', { 'xsi:type': 'xsd:decimal' }).txt((primeiroSkuDimensao.length / 100).toFixed(2)).up()
                        .ele('fatorMultiplicador', { 'xsi:type': 'xsd:integer' }).txt('1').up()
                    .up()
                .up()
            .end({ prettyPrint: true });
            return root;
        };

        const parseSswReturnXml = async (xmlString) => {
            const innerXmlMatch = xmlString.match(/<return xsi:type="xsd:string">([\s\S]*)<\/return>/);
            if (!innerXmlMatch || !innerXmlMatch[1]) {
                console.error('Não foi possível encontrar o XML aninhado dentro da resposta SSW.');
                return null;
            }
            const decodedInnerXml = innerXmlMatch[1]
                                    .replace(/&lt;/g, '<')
                                    .replace(/&gt;/g, '>')
                                    .replace(/&quot;/g, '"')
                                    .replace(/&amp;/g, '&');

            console.log('XML Interno Descodificado para Parse:', decodedInnerXml);

            return new Promise((resolve, reject) => {
                xml2js.parseString(decodedInnerXml, { explicitArray: false, mergeAttrs: true }, (err, result) => {
                    if (err) {
                        console.error('Erro ao parsear XML interno da SSW:', err);
                        return reject(err);
                    }
                    if (result && result.cotacao) {
                        const frete = result.cotacao.frete ? parseFloat(result.cotacao.frete.replace('.', '').replace(',', '.')) : 0;
                        const prazo = result.cotacao.prazo ? parseInt(result.cotacao.prazo, 10) : 0;
                        const erro = result.cotacao.erro ? parseInt(result.cotacao.erro, 10) : -1;
                        const mensagem = result.cotacao.mensagem || 'Erro desconhecido';

                        if (erro === 0) {
                           return resolve({ frete, prazo, mensagem });
                        } else {
                           console.warn(`SSW Retorno - Erro ${erro}: ${mensagem}`);
                           return resolve(null);
                        }
                    }
                    resolve(null);
                });
            });
        };

        // --- Requisição para SSW Rodoviária ---
        try {
            const payloadRodoviarioSSW = createSoapEnvelope({
                mercadoria: 1,
                ciffob: 'C',
                trt: 'N',
                coletar: 'N',
                entDificil: 'N',
                destContribuinte: 'N'
            }).toString();

            console.log('Payload SSW (Rodoviário) Enviado (XML):', payloadRodoviarioSSW);

            const responseRodoviarioSSW = await axios.post(
                sswApiUrl,
                payloadRodoviarioSSW,
                {
                    headers: {
                        'Content-Type': 'text/xml; charset=utf-8',
                        'SOAPAction': sswSoapAction
                    }
                }
            );

            const sswResponseXml = responseRodoviarioSSW.data;
            console.log('Resposta Bruta SSW (Rodoviário - XML):', sswResponseXml);

            const cotacaoRodoviaria = await parseSswReturnXml(sswResponseXml);
            
            if (cotacaoRodoviaria && cotacaoRodoviaria.frete > 0) {
                opcoesFrete.push({
                    "name": "Pajuçara Rodoviário",
                    "service": "Pajucara_Rodoviario", // >>> CONFIRME ESTE NOME NO PAINEL YAMPI
                    "price": cotacaoRodoviaria.frete,
                    "days": cotacaoRodoviaria.prazo,
                    "quote_id": "pajucara_rodoviario"
                });
                console.log('Cotação Rodoviária da Pajuçara adicionada com sucesso!');
            } else {
                 console.warn('Pajuçara (Rodoviário): Não foi possível extrair valor/prazo válido ou frete é zero. Resposta XML original:', sswResponseXml);
            }

        } catch (error) {
            console.error('Erro na requisição SSW (Pajuçara Rodoviário) ou processamento:', error.message);
            if (error.response && error.response.data) {
                console.error('Detalhes do erro da SSW (XML):', error.response.data);
            } else {
                console.error('Nenhum detalhe de resposta de erro da SSW disponível.');
            }
        }
        
        // --- Requisição para SSW Aérea ---
        try {
            const payloadAereoSSW = createSoapEnvelope({
                mercadoria: 1, 
                ciffob: 'C',
                trt: 'N',
                coletar: 'N',
                entDificil: 'N',
                destContribuinte: 'N'
            }).toString();

            console.log('Payload SSW (Aéreo) Enviado (XML):', payloadAereoSSW);

            const responseAereoSSW = await axios.post(
                sswApiUrl,
                payloadAereoSSW,
                {
                    headers: {
                        'Content-Type': 'text/xml; charset=utf-8',
                        'SOAPAction': sswSoapAction
                    }
                }
            );

            const sswResponseXmlAereo = responseAereoSSW.data;
            console.log('Resposta Bruta SSW (Aéreo - XML):', sswResponseXmlAereo);

            const cotacaoAerea = await parseSswReturnXml(sswResponseXmlAereo);

            if (cotacaoAerea && cotacaoAerea.frete > 0) {
                opcoesFrete.push({
                    "name": "Pajuçara Aéreo",
                    "service": "Pajucara_Aereo", // >>> CONFIRME ESTE NOME NO PAINEL YAMPI
                    "price": cotacaoAerea.frete,
                    "days": cotacaoAerea.prazo,
                    "quote_id": "pajucara_aereo"
                });
                console.log('Cotação Aérea da Pajuçara adicionada com sucesso!');
            } else {
                 console.warn('Pajuçara (Aéreo): Não foi possível extrair valor/prazo válido ou frete é zero. Resposta XML original:', sswResponseXmlAereo);
            }


        } catch (error) {
            console.error('Erro na requisição SSW (Pajuçara Aéreo) ou processamento:', error.message);
            if (error.response && error.response.data) {
                console.error('Detalhes do erro da SSW (XML):', error.response.data);
            } else {
                console.error('Nenhum detalhe de resposta de erro da SSW disponível.');
            }
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
    res.send('Middleware da Pajuçara rodando');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
