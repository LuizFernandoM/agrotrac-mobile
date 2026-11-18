# Validação incremental — 16/11/2026

## Evidências manuais no iPhone relatadas pelo usuário — registro em 16/11/2026

Fonte: relato direto do responsável pelo projeto na conversa. Execução física em iPhone com Expo Go e `npx expo start --tunnel`; não são testes automatizados nem observações realizadas pelo agente.

| Cenário relatado | Resultado manual |
|---|---|
| Abrir o aplicativo no Expo Go por tunnel | APROVADO pelo usuário |
| Continuar utilizando o aplicativo em modo avião | APROVADO pelo usuário |
| Registrar uma pesagem offline | APROVADO pelo usuário |
| Visualizar a pesagem na lista | APROVADO pelo usuário |
| Fechar completamente o Expo Go, reabrir o aplicativo e encontrar os registros armazenados | APROVADO pelo usuário |

Essas evidências confirmam o fluxo relatado de operação offline e persistência dos registros após reabertura no aparelho. O relato não especifica modelo/versões iOS e Expo Go, UUIDs, condições de rede durante a reabertura, captura/permissões de câmera ou persistência dos bytes da foto; esses detalhes não são inferidos como testados. Sincronização real iPhone → Gateway → Audit, FormData nativo, confirmação SYNCED e idempotência nesse caminho continuam PENDENTES. Os testes Windows abaixo permanecem evidências automatizadas separadas. Menções anteriores a iPhone ainda não executado descrevem a situação na entrega original, antes deste relato.

## Regressão adicional: limite real por arquivo versus corpo multipart

Parecer independente Copilot recebido da coordenação: revisão somente leitura sem bloqueadores identificados para primeiro ensaio OFFLINE iPhone (a compatibilidade SDK 58 ainda depende do aparelho), APIs File/Crypto/Image.getSize conferidas e nenhum defeito identificado em SQLite/single-flight/confirmação/permissões. O achado condicional sobre um suposto limite HTTP TOTAL de 10 MiB foi investigado com POST HTTP real, Audit/PostgreSQL/filesystem reais; a hipótese foi **refutada para o Audit atual**, sem reduzir o teto Mobile nem alterar backend.

Nova regressão no teste opt-in `tests/contract/audit.test.ts`: gera JPEG original de 48×64 pixels com sharp e insere segmentos JPEG COM válidos entre SOI e os segmentos originais até obter exatamente os dois tamanhos. São metadados JPEG legais, não bytes anexados após EOI; a imagem mantém pixels comprimidos originais. Ambas as imagens passam `imageDimensions` e decodificação COMPLETA libvips/sharp com `failOn:'warning'`, `limitInputPixels:16777216` e `.raw().toBuffer()`, confirmando 48×64×3 = 9.216 bytes de pixels. A validação Mobile `photoLimits` aceita exatamente 10 MiB e rejeita um byte acima. Fixtures JPEG originais/de fronteira são preservadas.

Execução final aprovada: schema exclusivo `mobile_contract_1794871364522_d25c3e9e`, relatório `tests/fixtures/mobile_contract_1794871364522_d25c3e9e/result.json`.

| Caso | Foto bytes | Corpo multipart bytes | Bytes recebidos no servidor | HTTP | Linhas SQL por UUID |
|---|---:|---:|---:|---:|---:|
| Exatamente limite | 10.485.760 | 10.486.261 | 10.486.261 | 201 | 1 |
| Replay idêntico | 10.485.760 | 10.486.261 | 10.486.261 | 200 | 1 (mesma linha/sequence) |
| Um byte acima | 10.485.761 | 10.486.262 | 10.486.262 | 413 FILE_TOO_LARGE | 0 |

UUID aceito: `8d557777-65d7-40d2-b120-48bf43508769`; SHA-256 `675b62023217772c8de3c4b8b6c99b8716e06a13d6598abe9355dbcc20eb7256`. UUID rejeitado: `0f07f3af-51e5-4fad-9655-2607f61d640b`; SHA-256 da fixture válida acima do limite `888904d598f260f32991b0721d2f9766722f064c0a4ac9bcc337f3b135c964ec`. SQL confirmou tamanho 10485760, MIME image/jpeg, hash igual; `storage.read` leu o arquivo persistido e confirmou novamente SHA-256. `confirmation` do domínio Mobile validou todas as propriedades nas respostas 201/200, incluindo a mesma sequência e timestamp. Contagem final no schema: três linhas (duas dos cenários anteriores e uma da fronteira); zero para o UUID rejeitado.

O boundary foi gerado automaticamente por Request/FormData Node. `request.clone().arrayBuffer()` mediu o corpo codificado e um listener passivo no request real do Audit contou os mesmos bytes recebidos. Não foi fixado Content-Type/boundary manualmente. O teste usa o `DiskPhotos` REAL com construtor default e afirma `storage.maxBytes===10485760`; nenhum limite reduzido de fixture foi usado. Isso comprova o comportamento HTTP multipart do Audit host, não o FormData nativo React Native nem um futuro proxy Gateway com limites próprios.

Fontes de código somente leitura: `../agrotrac-audit/src/infra/weighings-http.ts` configura `limits.fileSize = storage.maxBytes + 1` no parser multipart; `../agrotrac-audit/src/infra/storage.ts` soma bytes do stream **do arquivo** e rejeita `size > this.maxBytes`; o default de `DiskPhotos` é 10485760. `../agrotrac-audit/src/infra/image.ts` força decodificação completa e `infra/pg-weighings.ts` compara metadados/hash para idempotência. O bodyLimit JSON geral não impôs um teto total de 10 MiB a esse multipart, conforme o POST medido.

Comandos reais adicionais: `docker start agrotrac-core-test-relay-cf6006`, mesmas variáveis opt-in/PGPORT15432 do roteiro abaixo, `npm run test:contract` e `npm run typecheck`. Resultado final: contrato 1/1 passou (inclui cenários prévios e as três requisições de fronteira), typecheck passou; não foi reexecutada suíte backend completa nem foi necessário reexportar app porque só teste/documentação mudaram. Uma primeira execução da nova regressão errou o nome SQL da coluna MIME; foi corrigida para `file_mime_type AS mime_type`, preservando o schema/fixtures daquela tentativa, e duas execuções seguintes passaram. Relay foi iniciado/parado em `finally` e preservado; servidores/pool fecharam; infraestrutura já estava healthy e permaneceu ativa sem alterações. Nenhum commit/push/deploy/túnel externo ocorreu.

O Mobile permanece candidato para o primeiro ensaio offline. **iPhone nativo, câmera real, reabertura offline e acesso da API física continuam PENDENTES**; não foram executados nesta regressão. Sem alteração da URL/bind/firewall/credenciais, o tunnel Metro continua sem encaminhar a API local, e o Gateway permanece ausente.

## Arquivos entregues e artefatos preservados

Somente `agrotrac-mobile` recebeu alterações de arquivos: README.md atualizado; novos package.json/package-lock.json, tsconfig.json, index.ts, App.tsx, app.json/app.config.ts, .env.example/.gitignore; src/domain.ts, image.ts, repository.ts, sync.ts, http.ts, native.ts; tests/support.ts, domain.test.ts, sqlite-sync.test.ts, http.test.ts, contract/audit.test.ts; este documento e fixtures geradas em tests/fixtures. docs/offline-design.md já existia no início do despacho e foi somente lido, sem alteração. Nenhum commit, push, deploy, instalação em aparelho ou alteração de backend/infra/credenciais/roles foi feito.

Exportação final do código entregue: `exports/validated-release-candidate/metadata.json`, iOS `index-ddbad927d16aea4ef37c6b9650004966.hbc`, Android `index-82903a4b7691193f246afba8b7ff4a3d.hbc`. Bundles anteriores em dist, dist-ios e exports/validated-final foram preservados. Fixtures de testes totalizavam 233 arquivos (~2,88 MB), em 16 diretórios, no encerramento; nenhuma limpeza foi executada.

## Evidências e limites

| Camada | WINDOWS AUTOMATIZADO | IPHONE NÃO EXECUTADO |
|---|---|---|
| Domínio, kg, placa, opcionais, snapshot imutável | Passou em `npm test` | Pendente |
| Confirmação de todos os campos, SHA-256, tamanho, MIME, sequência positiva, UTC | Passou; divergências nunca SYNCED | Pendente com resposta real |
| Rede, timeout HTTP real, JSON inválido, 400/401/403/409/413/415, backoff persistido | Passou; sem loop automático | Pendente com rede iOS |
| Single-flight/eventos simultâneos/registro salvo durante upload/FIFO/SYNCED não reenviado | Passou | Pendente |
| Recuperação IN_FLIGHT uma vez por abertura | SQLite REAL em arquivo, fechado e reaberto; mesmas queries/migrations da classe Repository | Usuário aprovou persistência de registros ao fechar/reabrir; recuperação específica de IN_FLIGHT não relatada |
| Commit remoto com resposta perdida e replay | SQLite host + Audit/PostgreSQL reais: replay 200, apenas duas linhas para dois UUIDs distintos | FormData nativo React Native pendente |
| Imagens | Validação estrutural PNG/JPEG, CRC PNG, MIME/bytes/pixels; imagens reais geradas com sharp no contrato | Câmera, galeria, permissões e File/Directory pendentes |
| Expo SDK 58 | `expo install --check` passou; `expo-doctor` 20/20; typecheck passou | Versão instalada do Expo Go não inspecionada |
| Bundles | Android e iOS exportados no Windows, Hermes ~1,7 MB cada | Exportação não é execução nativa |
| Gateway/auth/E2E produto | Gateway ausente; auth real pendente | Bloqueado para sync final até endpoint acessível/autorizado |

`npm test`: 26 testes, 26 passaram, zero falhas; 12 casos de topo incluindo subcasos. `node:sqlite` é experimental no Node 22.14.0 (SQLite 3.47.2). O teste host comprova SQL, persistência e a classe Repository compartilhada; não comprova a ponte `expo-sqlite`/filesystem/FormData Android ou iOS. Testes de timeout Node não são tráfego de um aparelho.

## Comandos executados

No diretório `agrotrac-mobile`:

```powershell
npm view expo version engines --json
npm install
npx expo install react react-native expo-sqlite expo-file-system expo-image-picker expo-crypto @react-native-community/netinfo expo-build-properties
npx expo install typescript --dev
npm install --save-dev @types/node@^22
npm run typecheck
npm test
npx expo install --check
npx expo-doctor
npm run export:android
npx expo export --platform ios --output-dir dist-ios
npx expo export --platform android --platform ios --output-dir exports/validated-release-candidate
```

TypeScript inicialmente resolvido como 7.0.2 foi alinhado por `expo install` a 6.0.3. Um erro inicial de BOM no package.json foi corrigido. `expo-doctor` inicialmente identificou app.json não consumido; app.config.ts agora recebe e mescla `ConfigContext.config`, e o resultado final é 20/20. Os primeiros testes detectaram uma comparação incorreta do teste entre Row (estado mutável) e Snapshot; o teste passou a comparar exatamente payload/foto/bytes entre tentativas. Nenhum runtime global foi trocado.

`npm audit` reportou três achados moderados na cadeia Expo → @expo/fingerprint → minimatch (GHSA-g3hv-75wg-m249). Não foi aplicado `audit fix --force`, que propunha downgrade incompatível para Expo 52; não há achados altos/críticos nesse relatório.

## Contrato opt-in Audit real — PARCIAL

O script usa o código real do repositório Audit, PostgreSQL `agrotrac_audit`, schema novo exclusivo por execução e storage sob `tests/fixtures/mobile_contract_*`. Não usa Core E2E, não altera arquivo Audit e não acessa banco a partir do app. O servidor HTTP efêmero escuta só `127.0.0.1` em porta alocada pelo sistema; fecha em `finally`, assim como o pool. Requer dependências já instaladas no Audit; sharp é resolvido pelo package.json real do Audit.

Primeira conexão em 5432 falhou com SQLSTATE 28P01: era PostgreSQL Windows, não o banco Docker. Sob orientação explícita da coordenação, containers Compose existentes/parados foram iniciados com `docker compose start --wait --wait-timeout 90`; nenhum serviço/volume foi recriado. O relay existente `agrotrac-core-test-relay-cf6006` foi confirmado em `127.0.0.1:15432`, rede `agrotrac-infra_default`, iniciado só para o teste e parado/preservado ao final. Infra Compose foi preservada ativa, conforme orientação.

```powershell
# Somente quando a infraestrutura existente tiver sido autorizada e estiver ativa.
docker start agrotrac-core-test-relay-cf6006
$env:MOBILE_AUDIT_CONTRACT = '1'
$env:AUDIT_INFRA_ENV_PATH = (Resolve-Path ../agrotrac-infra/.env).Path
$env:PGHOST = '127.0.0.1'
$env:PGPORT = '15432'
try { npm run test:contract } finally { docker stop agrotrac-core-test-relay-cf6006 }
```

Credenciais são lidas opt-in em memória pelo Audit configuration; não são impressas, copiadas para Mobile nem expostas em EXPO_PUBLIC_*. Sem opt-in, `npm run test:contract` pula o teste. O script exige banco `agrotrac_audit` e migração `requireNew=true`; não reutiliza schema de produção. Uma execução inicial pelo relay criou schema/storage vazios antes de falhar na resolução antiga do caminho de sharp; ambos foram preservados, e a resolução foi corrigida com createRequire.

Contrato aprovado: 201 novo, 200 replay igual, 409 conteúdo divergente, validação pelo mesmo `confirmation` usado pelo app, commit seguido de resposta perdida/replay 200 e contagem SQL de duas linhas para dois UUIDs. Evidência final aprovada: tests/fixtures/mobile_contract_1794870703276_b8c5ee16/result.json; evidência inicial aprovada: `tests/fixtures/mobile_contract_1794870355214_705c26ef/result.json`; novas execuções geram novas pastas. Schema/storage e todos os bancos/fotos de testes host permanecem preservados. Este teste usa Blob/FormData Node; não executa o descritor de arquivo `{uri,type,name}` do React Native e não substitui o Gateway ou o aceite do produto.

## iPhone físico com Expo Go — roteiro para execução conjunta

Não foi iniciado túnel Metro nem backend público nesta tarefa. O usuário já possui Expo Go e já usa `--tunnel`; não há necessidade de instalar SDK Android, emulador ou ferramentas de build iOS no Windows.

1. Online, verificar a versão do Expo Go no iPhone e abrir este projeto. O projeto requer SDK 58; [Expo Go oficial](https://expo.dev/go) apresenta SDK 58 e o [histórico oficial da App Store](https://apps.apple.com/us/app/expo-go/id982107779) lista 58.0.5 com suporte ao SDK 58. Isso não confirma a versão instalada no iPhone. Se aparecer “incompatible SDK” ou “project is incompatible”, anotar a versão e a mensagem; alinhar Expo Go com SDK 58 pelas opções oficiais em conjunto. Não fazer downgrade silencioso deste projeto nem apagar dados do Expo Go. Se o host pedir conta, fazer login interativamente no CLI/Expo Go com a mesma conta, sem compartilhar senhas.
2. No PowerShell, dentro de Mobile, `npm ci` (instala somente dependências locais a partir do lockfile), `npx expo install --check`, `npm run typecheck`, e `npx expo start --tunnel`. O ngrok global já existente pode ser usado pelo CLI; não instalar ferramentas globais nem publicar backend automaticamente. Ler o QR com a câmera do iPhone e abrir no Expo Go. Confirmar que o formulário carrega online antes do modo avião. CLI/Metro ficam abertos durante o teste; encerrar com Ctrl+C ao terminar combinado.
3. Preencher placa/bruto/tara. Testar cancelar captura e negar permissão de câmera: formulário deve manter os campos e não criar registro incompleto. Depois conceder câmera nos ajustes do iPhone, se negada, e tirar uma foto real do romaneio. Testar galeria complementar. HEIC/outros formatos que não retornem bytes JPEG/PNG devem ser rejeitados claramente; o app não troca extensão para fingir JPEG. Validar foto normal e foto acima dos limites (10 MiB / 8192 por dimensão / 16.777.216 pixels), quando houver fixture disponível.
4. Ativar modo avião com app carregado. Fotografar/preencher `ABC1D23`, bruto `42000`, tara `14000` (líquido `28000`); salvar. Esperado PENDING, UUID, miniatura e tentativas visíveis. Sem API configurada, esse fluxo continua funcionando.
5. Fechar forçadamente Expo Go e reabrir o mesmo projeto em modo avião. Confirmar a mesma pesagem, UUID e foto. Se Expo Go não conseguir reabrir o bundle offline, registrar a limitação do host Expo Go separadamente: reconectar, recarregar o MESMO projeto sem reinstalar/apagar dados e verificar persistência; depois repetir offline com o bundle carregado. Não alegar perda do SQLite apenas por indisponibilidade do bundle.
6. Reconectar. Para sync final precisa existir URL HTTP(S) do Gateway acessível pelo iPhone. O tunnel Metro transporta o bundle, **não transporta a API**; `127.0.0.1`/`localhost` no iPhone apontam para o iPhone, e `10.0.2.2` só é alias do host no emulador Android oficial. Audit permanece bind 127.0.0.1 e Gateway ainda ausente. Caminhos a decidir/autorizados depois: Gateway HTTPS em ambiente de teste acessível ao aparelho ou encaminhamento HTTPS controlado especificamente da API de teste isolada. Não mudar bind/firewall/credenciais nem abrir túnel público automaticamente. Até então, testar sync manual contra URL indisponível: PENDING com erro/backoff, jamais SYNCED.
7. Com endpoint real acessível e auth definida, salvar URL no app (persistida em SQLite), usar “Sincronizar agora” e acompanhar PENDING → IN_FLIGHT → SYNCED. `isInternetReachable=null` não bloqueia manual. Aguardar o prazo de backoff mostrado e repetir botão/evento se necessário; não existe polling/timer periódico.
8. Acionar novamente o botão após SYNCED e comprovar ausência de POST novo nos logs autorizados do servidor. Criar outra pesagem durante um envio e confirmar FIFO/uma requisição por vez. Em teste controlado com schema isolado, perder resposta DEPOIS do commit, reconectar e confirmar replay 200 com mesmo UUID/payload/foto e uma linha SQL para aquele UUID. A interrupção deve ser combinada manualmente, sem derrubar produção. Para 409/400/413/415/auth, confirmar erro visível e ausência de loop em rede/AppState; snapshot permanece preservado, sem edição ou retry cego.

### Checklist a preencher pelo usuário/testador

| Evidência iPhone | Resultado / versão / UUID / data |
|---|---|
| Modelo, iOS, Expo Go e SDK aceito | Aplicativo abriu; modelo/versões não informados |
| QR/tunnel carregou formulário online | APROVADO — relato do usuário, Expo Go por tunnel |
| Permissão negada/cancelamento preservam formulário | PENDENTE |
| Câmera real e galeria JPEG/PNG | PENDENTE |
| Modo avião salvou PENDING + foto privada | Pesagem offline e listagem APROVADAS pelo usuário; status exato e foto privada não detalhados |
| Fechar/reabrir preservou SQLite e foto | Persistência dos registros APROVADA pelo usuário após encerrar Expo Go; foto não relatada |
| Limitação de reabrir bundle offline do Expo Go, se houver | PENDENTE |
| Endpoint Gateway acessível/auth definida | PENDENTE |
| FormData React Native real/timeout e confirmação | PENDENTE |
| SYNCED sem reenvio; perda de resposta com uma linha; 409 sem loop | PENDENTE |

Android nativo também permanece PENDENTE: não há SDK/adb/emulador disponível no inventário recebido e não foi instalado nada. O mesmo roteiro deve ser repetido em Android quando houver ambiente autorizado. `expo-build-properties` só afeta um binário gerado por prebuild; não muda o Expo Go instalado, nem sua política HTTP/ATS ou permissões. Em iPhone preferir endpoint HTTPS válido.

## Fontes oficiais consultadas e APIs efetivamente usadas

Consultadas em 16/11/2026, além de `npm view`, `expo install`, arquivos `.d.ts` locais e `npm ls --depth=0`:

- [Tabela de compatibilidade SDK](https://docs.expo.dev/versions/latest/): SDK 58, RN 0.88, React 19.3, Node mínimo 22.13.x.
- [SQLite](https://docs.expo.dev/versions/latest/sdk/sqlite/): incluído no Expo Go Android/iOS; openDatabaseAsync, execAsync, runAsync, getAllAsync e bind params.
- [FileSystem](https://docs.expo.dev/versions/latest/sdk/filesystem/): incluído no Expo Go; File, Directory, Paths.document, bytes, copy(overwrite:false), create. API moderna; não usa métodos legacy que lançam erro no módulo moderno.
- [ImagePicker](https://docs.expo.dev/versions/latest/sdk/imagepicker/): incluído no Expo Go; requestCameraPermissionsAsync, launchCameraAsync, launchImageLibraryAsync, ImagePickerAsset. Câmera efetiva exige ensaio físico.
- [Crypto](https://docs.expo.dev/versions/latest/sdk/crypto/): incluído no Expo Go; randomUUID v4, digest SHA-256 de bytes (não hash da string base64).
- [NetInfo](https://docs.expo.dev/versions/latest/sdk/netinfo/): 12.0.1 incluído no Expo Go; eventos e fetch.
- [BuildProperties](https://docs.expo.dev/versions/latest/sdk/build-properties/): usesCleartextTraffic em config plugin, só prebuild; sem efeito no Expo Go.
- [Expo Go](https://expo.dev/go), [App Store release notes](https://apps.apple.com/us/app/expo-go/id982107779), [ambiente Expo](https://docs.expo.dev/get-started/set-up-your-environment/): compatibilidade disponível, mas versão do aparelho ainda deve ser verificada. Não foram seguidas instruções de instalar/buildar Expo Go, pois o usuário já tem host funcional.
- Contrato local autoritativo: `../agrotrac-audit/src/domain/weighing.ts`, `domain/event.ts`, `infra/weighings-http.ts`, `infra/image.ts`, `application/weighings.ts`, `infra/migration.ts`. Resposta é objeto direto, não envelope; limite HTTP padrão 10 MiB apesar do teto configurável interno de 100 MiB.
