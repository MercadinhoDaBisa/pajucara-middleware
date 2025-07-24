require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const { create } = require('xmlbuilder2'); // <<< NOVIDADE: Importa xmlbuilder2

const app = express();

// Manter express.raw para pegar o body bruto da Yampi para validação HMAC
app.use(express.raw({ type: 'application/json' }));

// Remover express.json() pois vamos parsear o JSON da Yampi manualmente e construir XML para SSW

// --- Variáveis de Ambiente Yampi ---
const YAMPI_SECRET_TOKEN = process.env.YAMPI_SECRET_TOKEN;

// --- Variáveis de Ambiente Pajuçara (SSW) ---
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
    let yampiData; // Declarar yampiData aqui para ser acessível globalmente no try/catch
    try {
        const hmac = crypto.createHmac('sha256', YAMPI_SECRET_TOKEN);
        yampiData = JSON.parse(requestBodyRaw.toString('utf8')); // <<< ATENÇÃO: Parseia o body bruto aqui
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
        const cnpjCpfDestinatario = yampiData.cart && yampiData.cart.customer ? yampiData.cart.customer.document : null;

        let pesoTotal = 0;
        let cubagemTotal = 0; // em m³
        let qtdeVolumeTotal = 0;

        if (yampiData.skus && Array.isArray(yampiData.skus)) {
            yampiData.skus.forEach(sku => {
                const pesoItem = sku.weight || 0;
                const quantidadeItem = sku.quantity || 1;
                const comprimento = sku.length || 0; // cm
                const largura = sku.width || 0;     // cm
                const altura = sku.height || 0;     // cm

                pesoTotal += pesoItem * quantidadeItem;
                // cubagem total em m³
                cubagemTotal += (comprimento * largura * altura / 1000000) * quantidadeItem;
                qtdeVolumeTotal += quantidadeItem;
            });
        }

        const opcoesFrete = [];

        // --- URL e SOAPAction para Pajuçara (SSW) ---
        const sswApiUrl = 'https://ssw.inf.br/ws/sswCotacaoColeta/index.php';
        const sswSoapAction = 'urn:sswinfbr.sswCotacaoColeta#cotarSite';

        // Helper para criar o envelope SOAP
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
                    .ele('tns:cotarSite') // <<<< Método SOAP a ser chamado
                        // Adiciona cada parâmetro da função cotarSite
                        .ele('dominio', { 'xsi:type': 'xsd:string' }).txt(SSW_DOMAIN).up()
                        .ele('login', { 'xsi:type': 'xsd:string' }).txt(SSW_LOGIN).up()
                        .ele('senha', { 'xsi:type': 'xsd:string' }).txt(SSW_PASSWORD).up()
                        .ele('cnpjPagador', { 'xsi:type': 'xsd:string' }).txt(SSW_CNPJ).up()
                        .ele('senhaPagador', { 'xsi:type': 'xsd:string' }).txt(SSW_PAGADOR_PASSWORD).up()
                        .ele('cepOrigem', { 'xsi:type': 'xsd:integer' }).txt(parseInt(cepOrigemFixo)).up()
                        .ele('cepDestino', { 'xsi:type': 'xsd:integer' }).txt(parseInt(cepDestino)).up()
                        .ele('valorNF', { 'xsi:type': 'xsd:decimal' }).txt(valorDeclarado.toFixed(2)).up() // Formata para 2 casas decimais
                        .ele('quantidade', { 'xsi:type': 'xsd:integer' }).txt(qtdeVolumeTotal).up()
                        .ele('peso', { 'xsi:type': 'xsd:decimal' }).txt(pesoTotal.toFixed(3)).up() // Peso com 3 casas decimais
                        .ele('volume', { 'xsi:type': 'xsd:decimal' }).txt(cubagemTotal.toFixed(6)).up() // Cubagem com 6 casas decimais
                        // Novos campos do WSDL (usando valores padrão ou do ambiente, se aplicável)
                        .ele('mercadoria', { 'xsi:type': 'xsd:integer' }).txt(methodParams.mercadoria || 1).up()
                        .ele('ciffob', { 'xsi:type': 'xsd:string' }).txt(methodParams.ciffob || 'C').up() // C = CIF
                        .ele('cnpjRemetente', { 'xsi:type': 'xsd:string' }).txt(SSW_CNPJ).up() // Remetente é o próprio pagador
                        .ele('cnpjDestinatario', { 'xsi:type': 'xsd:string' }).txt(cnpjCpfDestinatario || '').up()
                        .ele('observacao', { 'xsi:type': 'xsd:string' }).txt('').up() // Vazio por padrão
                        .ele('trt', { 'xsi:type': 'xsd:string' }).txt(methodParams.trt || 'N').up()
                        .ele('coletar', { 'xsi:type': 'xsd:string' }).txt(methodParams.coletar || 'N').up()
                        .ele('entDificil', { 'xsi:type': 'xsd:string' }).txt(methodParams.entDificil || 'N').up()
                        .ele('destContribuinte', { 'xsi:type': 'xsd:string' }).txt(methodParams.destContribuinte || 'N').up()
                        // Campos não enviados pelo Yampi, mas presentes no WSDL. Se a SSW exigir,
                        // eles terão que vir com valores padrao ou null se nao se aplicarem ao seu cenário
                        .ele('qtdePares', { 'xsi:type': 'xsd:integer' }).txt('0').up() // Assume 0, se não houver pares
                        .ele('altura', { 'xsi:type': 'xsd:decimal' }).txt('0').up() // Assume 0 se não for por item
                        .ele('largura', { 'xsi:type': 'xsd:decimal' }).txt('0').up() // Assume 0 se não for por item
                        .ele('comprimento', { 'xsi:type': 'xsd:decimal' }).txt('0').up() // Assume 0 se não for por item
                        .ele('fatorMultiplicador', { 'xsi:type': 'xsd:integer' }).txt('1').up() // Assume 1, se não houver multiplicador
                    .up() // Fecha tns:cotarSite
                .up() // Fecha SOAP-ENV:Body
            .end({ prettyPrint: true }); // prettyPrint para log mais legível
            return root;
        };

        // --- Requisição para SSW Rodoviária ---
        try {
            const payloadRodoviarioSSW = createSoapEnvelope({
                mercadoria: 1, // Exemplo: 1 para Geral. Confirme com SSW.
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
                        'Content-Type': 'text/xml; charset=utf-8', // <<< Content-Type para XML
                        'SOAPAction': sswSoapAction // <<< SOAPAction obrigatório
                    }
                }
            );

            // A resposta SOAP geralmente vem como XML. Precisamos parseá-la.
            // Para simplicidade, vamos tentar uma regex ou parseador simples primeiro.
            // Se a resposta for complexa, podemos precisar de uma lib de parsing XML (ex: xml2js)
            const sswResponseXml = responseRodoviarioSSW.data;
            console.log('Resposta Bruta SSW (Rodoviário - XML):', sswResponseXml);

            // Tentar extrair o valor e prazo de um retorno XML simples
            const matchValor = sswResponseXml.match(/<Valor xsi:type="xsd:string">([\d.,]+)<\/Valor>/);
            const matchPrazo = sswResponseXml.match(/<Prazo xsi:type="xsd:string">(\d+)<\/Prazo>/); // Ajustado para capturar apenas números

            const valorRodoviario = matchValor ? parseFloat(matchValor[1].replace('.', '').replace(',', '.')) : 0;
            const prazoRodoviario = matchPrazo ? parseInt(matchPrazo[1], 10) : 0;
            
            if (valorRodoviario > 0) { // Apenas adiciona se tiver um valor válido
                opcoesFrete.push({
                    "name": "Pajuçara Rodoviário",
                    "service": "Pajucara_Rodoviario",
                    "price": valorRodoviario,
                    "days": prazoRodoviario,
                    "quote_id": "pajucara_rodoviario"
                });
            } else {
                 console.warn('Pajuçara (Rodoviário): Não foi possível extrair valor/prazo ou valor é zero. Resposta XML:', sswResponseXml);
            }

        } catch (error) {
            console.error('Erro na requisição SSW (Pajuçara Rodoviário) ou processamento:', error.message);
            if (error.response && error.response.data) {
                console.error('Detalhes do erro da SSW (XML):', error.response.data);
            } else {
                console.error('Nenhum detalhe de resposta de erro da SSW disponível.');
            }
        }
        
        // --- Requisição para SSW Aérea (se aplicável, com tpServico diferente) ---
        // Para a modalidade Aérea, você provavelmente precisará de um 'tpServico' diferente
        // e possivelmente outros campos específicos para o cálculo aéreo da Pajuçara.
        // Se a API 'cotarSite' suportar diferentes 'tpServico' ou houver outro método SOAP para aéreo,
        // você precisará ajustar aqui. Por agora, vou duplicar, mas é algo a se investigar com a SSW.
        try {
            const payloadAereoSSW = createSoapEnvelope({
                mercadoria: 1, // Geral, mas pode ser diferente para Aéreo
                ciffob: 'C',
                trt: 'N',
                coletar: 'N',
                entDificil: 'N',
                destContribuinte: 'N'
                // Aqui você pode adicionar um campo 'tpServico' se o WSDL permitir e se for diferente para Aéreo.
                // Atualmente, o WSDL que você passou não tem 'tpServico' como um 'part' de 'cotarSite'.
                // Isso sugere que 'cotarSite' é genérico e o tipo de serviço é inferido, ou há outro método.
                // Se 'tpServico' for necessário, você precisará confirmar com a SSW como enviá-lo.
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

            const matchValorAereo = sswResponseXmlAereo.match(/<Valor xsi:type="xsd:string">([\d.,]+)<\/Valor>/);
            const matchPrazoAereo = sswResponseXmlAereo.match(/<Prazo xsi:type="xsd:string">(\d+)<\/Prazo>/);

            const valorAereo = matchValorAereo ? parseFloat(matchValorAereo[1].replace('.', '').replace(',', '.')) : 0;
            const prazoAereo = matchPrazoAereo ? parseInt(matchPrazoAereo[1], 10) : 0;

            if (valorAereo > 0) {
                opcoesFrete.push({
                    "name": "Pajuçara Aéreo", // Ajuste o nome conforme a modalidade Aérea da Pajuçara
                    "service": "Pajucara_Aereo",
                    "price": valorAereo,
                    "days": prazoAereo,
                    "quote_id": "pajucara_aereo"
                });
            } else {
                 console.warn('Pajuçara (Aéreo): Não foi possível extrair valor/prazo ou valor é zero. Resposta XML:', sswResponseXmlAereo);
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