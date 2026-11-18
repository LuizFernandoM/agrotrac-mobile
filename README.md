# AgroTrac Mobile

Aplicativo Expo React Native TypeScript para registrar pesagens offline com foto do romaneio e sincronização idempotente. O usuário aprovou manualmente no iPhone com Expo Go/tunnel: abertura, uso em modo avião, registro/listagem de pesagem offline e persistência dos registros após fechar completamente e reabrir o Expo Go. Sincronização real via Gateway, detalhes de câmera/foto e execução Android permanecem pendentes. Essas evidências manuais estão separadas dos testes automatizados em docs/validation.md.

Leia [validação e roteiro do iPhone](docs/validation.md) e [desenho offline com revisão vinculante](docs/offline-design.md). A validação da autenticação com Gateway e Live reais está pendente. O contrato direto com Audit é uma verificação técnica parcial.

## Executar no iPhone com Expo Go

No PowerShell, dentro desta pasta:

    npm ci
    npx expo install --check
    npm run typecheck
    npx expo start --tunnel

Com o iPhone online, leia o QR pela câmera e abra no Expo Go instalado. Carregue o formulário antes de ativar modo avião. Não foi iniciado túnel nesta entrega. Se o host solicitar conta, faça login interativamente na mesma conta no CLI e no Expo Go.

O projeto usa SDK 58. O portal oficial Expo Go e as notas oficiais da App Store apresentam suporte ao SDK 58 (Expo Go 58.0.5); a versão já instalada no seu iPhone ainda precisa ser conferida. Se houver erro de SDK incompatível, registre a mensagem e alinhe a versão pelas opções oficiais; não faça downgrade silencioso nem apague os dados do projeto. Não há dependência nativa customizada exigindo dev build: SQLite, FileSystem, ImagePicker, Crypto e NetInfo constam como incluídos no Expo Go para iOS/Android nas fontes oficiais.

É possível testar formulário, câmera, galeria, modo avião e persistência sem API. O modo avião não garante que o próprio host Expo Go conseguirá reabrir o bundle após ser encerrado: se isso acontecer, recarregue online o mesmo projeto sem apagar dados e verifique SQLite/foto separadamente. O checklist completo está em docs/validation.md.

## Configurar a API

A URL base do produto aponta ao Gateway; pode ser definida em EXPO_PUBLIC_API_URL antes de iniciar Metro ou salva em “Conexão ao Gateway” no app. O setting persistido prevalece sobre a variável pública. Sem URL, gravação offline continua disponível.

    $env:EXPO_PUBLIC_API_URL = 'https://gateway-de-teste.exemplo.invalid'
    npx expo start --tunnel

Use a URL autorizada do Gateway e informe usuário e senha na tela do app. O app envia login e logout para `/v1/live/auth/login` e `/v1/live/auth/logout`. Cada envio a `/v1/audit/weighings/sync` usa o cabeçalho `Authorization: Bearer`. O token fica em memória. Após reiniciar o app ou trocar a URL salva, entre novamente para sincronizar.

**Tunnel Expo encaminha Metro/bundle.** O sync no iPhone depende de um Gateway HTTPS autorizado e alcançável pelo aparelho. No iPhone, localhost/127.0.0.1 corresponde ao próprio aparelho. No emulador Android oficial, 10.0.2.2 representa o host.

Expiração, HTTP 401 no sync e logout pausam os envios até um novo login. Pesagens e fotos permanecem no aparelho, e a captura offline segue disponível. Se o Gateway estiver indisponível no logout, a sessão local termina e o app indica que a revogação remota ficou sem confirmação.

O plugin oficial expo-build-properties configura usesCleartextTraffic exclusivamente em builds próprios de desenvolvimento com AGROTRAC_DEV_CLEARTEXT=1 e NODE_ENV diferente de production; produção mantém false. O plugin NÃO modifica o binário Expo Go nem libera HTTP/ATS no iPhone. Não se deve esperar que app.config.ts altere permissões/políticas do host Expo Go.

## Persistência e sync

- Formulário: placa, bruto/tara em kg inteiros seguros, líquido calculado, agendamento UUID/motorista/documento/observações opcionais, captured_at UTC do momento de salvar.
- Câmera e galeria via expo-image-picker; cancelamento/permissão negada preservam formulário. JPEG/PNG reais: assinatura/estrutura (CRC PNG), dimensões do arquivo e leitura de dimensões nativa, até 10 MiB, 8192 por dimensão e 16.777.216 pixels. Outros formatos são rejeitados; não há transformação disfarçada por extensão.
- Copia bytes para Paths.document/romaneios antes do INSERT. Não sobrescreve/apaga origem, destino ou órfãos. Confere SHA-256/tamanho da cópia. Snapshot canônico e foto são imutáveis por domínio/trigger SQLite; UUID v4 estável.
- Repository usa migrations versionadas, WAL/FULL, constraints e transições condicionais; recupera IN_FLIGHT uma vez na inicialização. Lista mostra estado, erros, tentativas, bloqueio e prazo.
- Single-flight FIFO, eventos NetInfo/AppState, botão manual e registro novo. Eventos durante upload são coalescidos; trava liberada em finally. Não inicia novos envios ao entrar em segundo plano; o upload já iniciado pode ser suspenso/falhar pelo sistema. Sem polling/sync oculto com app fechado.
- Retry transitório preserva attempts/next_attempt_at com backoff de 2 s até 60 s. Retoma em novo evento/botão após o prazo. Erros 400/403/413/415 e conflitos 409 ficam visíveis sem repetição automática. O 401 devolve a pesagem à fila para retomar com a próxima sessão.
- FormData contém exatamente weighing (string JSON) e romaneio (arquivo), boundary automático. 201/200 só marcam SYNCED se todos os campos canônicos e hash/tamanho/MIME coincidirem e sequence positiva/received_at UTC forem válidos. SYNCED nunca é reenviado.

## Verificação host e contrato parcial

Revisão independente Copilot somente leitura não encontrou bloqueadores para o primeiro ensaio offline no iPhone, condicionado à compatibilidade SDK 58 no aparelho; APIs locais File/Crypto/Image.getSize foram conferidas. A hipótese condicional de que uma foto de 10 MiB seria rejeitada por overhead multipart foi **refutada no Audit real**: JPEG válido de 10.485.760 bytes, corpo de 10.486.261 bytes, retornou 201 e replay 200 com uma única linha SQL e hash/foto iguais; JPEG válido de 10.485.761 bytes retornou 413 sem linha SQL. O limite padrão é por arquivo, não pelo corpo multipart total; não houve mudança de limite Mobile/backend. Evidência e ressalvas em docs/validation.md; iPhone e API física continuam pendentes.

    npm test
    npm run typecheck
    npx expo install --check
    npx expo-doctor
    npm run export:android
    npm run export:ios
    npm run test:contract

26 testes host aprovados, SQLite REAL em arquivo/reabertura com mesmas queries/migrations, HTTP timeout/JSON inválido, falhas permanentes, concorrência e confirmação perdida. Expo doctor 20/20 e bundles Android/iOS gerados no Windows. Isso NÃO comprova câmera, ponte expo-sqlite, arquivos ou FormData nativos no aparelho.

test:contract é opt-in (MOBILE_AUDIT_CONTRACT=1), importa Audit real e cria schema PostgreSQL/storage exclusivos; credenciais entram apenas pelo ambiente/arquivo opt-in do Audit. Validou 201/200/409, resposta perdida após commit e replay 200, usando o mesmo domínio de confirmação. Comandos de relay15432 e evidências estão em docs/validation.md. Relay iniciado foi parado/preservado, servidores/pool de teste fechados; fixtures e schemas preservados. Não executar a suíte Core inteira para este contrato.

## Versões resolvidas e fontes

Node preservado 22.14.0, npm 10.9.2. Instalados: Expo 58.0.25; React Native 0.88.1; React 19.3.0; expo-sqlite 58.0.17; expo-file-system 58.0.13; expo-image-picker 58.0.10; expo-crypto 58.0.8; NetInfo 12.0.1; expo-build-properties 58.0.12; TypeScript 6.0.3; tsx 4.23.15; @types/react 19.3.0; @types/node 22.20.5. Lockfile fixa a resolução real. Expo SDK 58 exige Node mínimo 22.13.x; nenhum runtime global foi alterado.

Fontes oficiais consultadas em 16/11/2026: [compatibilidade Expo](https://docs.expo.dev/versions/latest/), [SQLite](https://docs.expo.dev/versions/latest/sdk/sqlite/), [FileSystem moderno](https://docs.expo.dev/versions/latest/sdk/filesystem/), [ImagePicker](https://docs.expo.dev/versions/latest/sdk/imagepicker/), [Crypto](https://docs.expo.dev/versions/latest/sdk/crypto/), [NetInfo](https://docs.expo.dev/versions/latest/sdk/netinfo/), [BuildProperties](https://docs.expo.dev/versions/latest/sdk/build-properties/), [Expo Go](https://expo.dev/go), [App Store](https://apps.apple.com/us/app/expo-go/id982107779). APIs e evidências detalhadas em docs/validation.md.

npm audit reporta três achados moderados na cadeia de ferramentas Expo/fingerprint/minimatch, sem altos/críticos; o downgrade incompatível sugerido por audit fix --force não foi aplicado.
