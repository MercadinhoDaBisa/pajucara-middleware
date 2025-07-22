require('dotenv').config(); // Carrega variáveis de ambiente do arquivo .env
const express = require('express'); // Framework web para Node.js
const axios = require('axios'); // Cliente HTTP para fazer requisições (para a SSW)
const https = require('https'); // Módulo HTTPS para configurar o agente
const crypto = require('crypto'); // Módulo nativo do Node.js para operações criptográficas (HMAC)

const app = express(); // Inicializa o aplicativo Express

// Middleware para obter o corpo bruto da requisição ANTES de ser parseado como JSON.
app.use(express.raw({ type: 'application/json' })); 
app.use(express.json()); 

// Configuração do agente HTTPS para aceitar certificados não autorizados (se necessário)
const agent = new https.Agent({
  rejectUnauthorized: false // Em produção, considere 'true' se confiar nos certificados da SSW
});

// Chave secreta da Yampi para esta API (nova, específica para Pajuçara/SSW)
const YAMPI_SECRET_TOKEN = process.env.YAMPI_SECRET_TOKEN;

// Credenciais da SSW, puxadas das variáveis de ambiente
const SSW_CHAVE = process.env.SSW_CHAVE;   // Seu 'Domínio' (PAJ)
const SSW_LOGIN = process.env.SSW_LOGIN; // Seu 'Usuário' (dabrisa)
const SSW_SENHA = process.env.SSW_SENHA; // Sua 'Senha' (Paju595)
const SSW_CNPJ_REMETENTE = "59554346000184"; // CNPJ do remetente (Mercadinho da Bisa)

// Rota POST para a cotação de frete, que a Yampi chamará.
app.post('/cotacao', async (req, res) => {
  console.log('Todos os Headers Recebidos:', req.headers);

  const yampiSignature = req.headers['x-yampi-hmac-sha256']; 
  const requestBodyRaw = req.body; 

  console.log('--- DIAGNÓSTICO DE SEGURANÇA YAMPI ---');
  console.log('Assinatura Yampi recebida (X-Yampi-Hmac-SHA256):', yampiSignature);
  console.log('Chave Secreta Yampi (YAMPI_SECRET_TOKEN do .env/Render):', YAMPI_SECRET_TOKEN);

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

    const cepDestino = yampiData.zipcode ? yampiData.zipcode.replace(/\D/g, '') : null;
    const valorDeclarado = yampiData.amount || 0;

    let pesoTotal = 0;
    let cubagemTotal = 0; // Para SSW
    let qtdeVolumes = 0;  // Para SSW

    if (yampiData.skus && Array.isArray(yampiData.skus)) {
      yampiData.skus.forEach(sku => {
        const quantity = sku.quantity || 1;
        pesoTotal += (sku.weight || 0) * quantity; 

        // Calcular cubagem individual em m³ e somar
        const lengthCm = sku.length || 0;
        const widthCm = sku.width || 0;
        const heightCm = sku.height || 0;
        // Cubagem em m³ por volume = (L * C * A) / 1,000,000 (se L,C,A em cm)
        cubagemTotal += (lengthCm * widthCm * heightCm / 1000000) * quantity; 

        qtdeVolumes += quantity; // Somar a quantidade de volumes/itens
      });
    }

    // Definir os tipos de serviço SSW que desejamos cotar
    const sswTiposServico = [
      { id: "1", nome: "Rodoviário" }, // Exemplo: Rodoviário
      { id: "2", nome: "Aéreo" }      // Exemplo: Aéreo
      // Adicione outros tipos se a Pajuçara oferecer e você quiser cotar
    ];

    const opcoesFrete = [];

    // Loop para cada tipo de serviço da SSW
    for (const tipoServico of sswTiposServico) {
      const payloadCotacaoSSW = {
        param: {
          Chave: SSW_CHAVE,
          CNPJ: SSW_CNPJ_REMETENTE, // CNPJ do remetente
          Login: SSW_LOGIN,
          Senha: SSW_SENHA
        },
        filtro: {
          tpServico: tipoServico.id, // Usando o ID do serviço do loop
          tpCobranca: "C", // C = CIF (pagamento na origem - geralmente frete pago pelo remetente)
          cepOrigem: "30720404", // CEP do remetente (Mercadinho da Bisa)
          cepDestino: cepDestino, // CEP do destinatário da Yampi
          cnpjCpfDestinatario: (yampiData.cart && yampiData.cart.customer && yampiData.cart.customer.document) ? yampiData.cart.customer.document.replace(/\D/g, '') : null, // CPF/CNPJ do destinatário
          retira: "N", // N = Não retirar (entrega domiciliar)
          peso: pesoTotal,
          cubagem: cubagemTotal,
          valorNota: valorDeclarado,
          qtdeVolume: qtdeVolumes > 0 ? qtdeVolumes : 1 // Garante pelo menos 1 volume
        }
      };

      console.log(`Payload SSW (${tipoServico.nome}) Enviado:`, JSON.stringify(payloadCotacaoSSW, null, 2));

      try {
        const respostaSSW = await axios.post(
          'https://ssw.inf.br/ws/sswCotacaoColeta/CotacaoColeta.asmx/json/CalculaFrete', 
          payloadCotacaoSSW,
          {
            headers: {
              'Content-Type': 'application/json' 
            },
            httpsAgent: agent 
          }
        );

        console.log(`Resposta Bruta da SSW (${tipoServico.nome}):`, JSON.stringify(respostaSSW.data, null, 2));

        if (respostaSSW.data && respostaSSW.data.sucesso && Array.isArray(respostaSSW.data.cotacao) && respostaSSW.data.cotacao.length > 0) {
          respostaSSW.data.cotacao.forEach(cotacao => {
            // Verifica se a cotação é válida e tem valor e prazo
            if (cotacao.valorFrete !== undefined && cotacao.prazoEntrega !== undefined) {
              opcoesFrete.push({
                "name": `Pajuçara ${cotacao.nmServico || tipoServico.nome}`, // Nome amigável na Yampi
                "service": `Pajuçara ${cotacao.nmServico || tipoServico.nome}`, // Campo 'service'
                "price": cotacao.valorFrete, 
                "days": cotacao.prazoEntrega, 
                "quote_id": `SSW-${cotacao.tpServico}-${cotacao.prazoEntrega}-${cotacao.valorFrete}`.replace(/\./g, '') // ID único e mais robusto
              });
            }
          });
        } else {
            console.warn(`Resposta da SSW (${tipoServico.nome}) não contém cotações válidas ou está vazia:`, respostaSSW.data);
        }
      } catch (error) {
        console.error(`Erro na requisição SSW (${tipoServico.nome}):`, error.message);
        if (error.response && error.response.data) {
            console.error('Detalhes do erro da SSW:', error.response.data);
        }
        // Não retorna erro aqui, apenas loga, para que outras modalidades/transportadoras possam ser exibidas
      }
    } // Fim do loop de tipos de serviço SSW

    const respostaFinalYampi = {
      "quotes": opcoesFrete
    };

    console.log('Resposta FINAL enviada para Yampi:', JSON.stringify(respostaFinalYampi, null, 2));

    res.json(respostaFinalYampi); 

  } catch (erro) {
    console.error('Erro geral no processamento do frete:', erro.message); 
    if (erro.response && erro.response.data) {
        console.error('Detalhes do erro da API externa:', erro.response.data);
    }
    return res.status(500).json({ erro: erro.message });
  }
});

app.get('/', (req, res) => {
  res.send('Middleware da Pajuçara (SSW Logística) rodando');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
