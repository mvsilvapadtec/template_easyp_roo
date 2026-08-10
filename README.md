# Template EasyPanel para o Roomote

Template não-oficial do [EasyPanel](https://easypanel.io) para hospedar o
[Roomote](https://github.com/RooCodeInc/Roomote) — a plataforma self-hosted
de agentes de IA para codar, que roda tarefas contra seus repositórios a
partir do Slack, Microsoft Teams ou da própria web.

O template sobe a stack completa de produção de host único descrita no
[`SELF_HOSTING.md`](https://github.com/RooCodeInc/Roomote/blob/main/SELF_HOSTING.md)
do Roomote: `web`, `api`, `controller`, fila `bullmq`, `postgres`, `redis` e
armazenamento de artefatos `minio`, usando o provedor de sandbox Docker (as
tarefas rodam como containers "irmãos" no mesmo host, através de um proxy
restrito do socket do Docker — nenhum serviço monta o socket real além do
próprio proxy).

## Estrutura deste repositório

```
templates/roomote/
  meta.yaml           # metadados + schema de input, no formato oficial do EasyPanel
  index.ts            # gerador (TypeScript) no formato usado por easypanel-io/templates
  example-output.json # exemplo do JSON gerado, com segredos substituídos por
                       # placeholders — só para inspecionar o formato, não use
                       # para deploy (ver aviso abaixo)
  assets/
    logo.png          # ícone oficial do Roomote (extraído do próprio repo do projeto)
    screenshot.png    # screenshot real de produto (revisão de PR pelo bot Roomote)
scripts/
  generate-schema.mjs  # gerador standalone (zero dependências) que produz o
                        # JSON pronto para colar no EasyPanel
```

Existem dois jeitos de usar isso, dependendo do que você quer:

1. **Deploy rápido, agora**: rode `scripts/generate-schema.mjs` localmente e
   cole o JSON gerado no EasyPanel (seção "Como fazer o deploy" abaixo).
2. **Contribuir o template oficialmente** ao catálogo do EasyPanel: use
   `templates/roomote/` dentro de um clone de
   [easypanel-io/templates](https://github.com/easypanel-io/templates)
   (siga o `README.md` daquele repositório: `npm run dev` abre o playground
   de testes, e lá dá pra testar o `generate()` antes de abrir um PR).

## Pré-requisitos

- Um servidor com EasyPanel instalado, com **acesso ao socket do Docker do
  host** (padrão em qualquer instalação EasyPanel) — o `controller` do
  Roomote precisa disso para rodar as tarefas como containers.
- 8 GB+ de RAM recomendado (o provedor de sandbox `docker` roda as tarefas no
  mesmo host; com sandboxes hospedados como Modal/E2B/Daytona, 4 GB bastam,
  mas isso exige configuração adicional pós-deploy — ver "Sandboxes
  hospedados" abaixo).
- Um domínio (ou o domínio automático `*.easypanel.host` que o próprio
  EasyPanel oferece) para os serviços `web`, `api` e `minio`. Todos precisam
  de HTTPS — o EasyPanel cuida disso automaticamente.
- Uma chave de API de um provedor de modelo (ex.: OpenRouter, Anthropic,
  OpenAI) — inserida no assistente `/setup` depois do primeiro boot, **não**
  neste template.
- Node.js instalado na sua máquina local só para rodar o gerador do JSON
  (qualquer versão razoavelmente recente; o script não usa dependências
  externas).

## Como fazer o deploy

### 1. Gere o JSON do template

```sh
node scripts/generate-schema.mjs --name meu-roomote > roomote.easypanel.json
```

Flags opcionais:

| Flag              | Padrão                                    | Descrição                                              |
| ----------------- | ------------------------------------------ | -------------------------------------------------------- |
| `--name`          | `roomote`                                  | Prefixo usado no nome de cada serviço (ex.: `<nome>-web`) |
| `--image`         | `ghcr.io/roocodeinc/roomote-app:main`      | Imagem da aplicação Roomote                              |
| `--license-key`   | (vazio)                                    | Chave de licença, só necessária acima de 10 usuários      |

**Importante**: cada execução gera senhas e chaves aleatórias novas. Não
faça commit do JSON gerado — trate-o como um arquivo de segredos (o
`.gitignore` deste repo já ignora `*.easypanel.json` por isso). Um
`ENCRYPTION_KEY`/`SETUP_TOKEN`/senha conhecidos publicamente por qualquer
pessoa que já tenha visto este repositório deixariam de proteger qualquer
coisa no dia em que alguém colasse esse JSON específico no EasyPanel sem
regenerar. Para só olhar o formato do JSON sem gerar nada, veja
[`templates/roomote/example-output.json`](templates/roomote/example-output.json)
— é o mesmo output, mas com os segredos trocados por
`REPLACE_WITH_RANDOM_VALUE`; ele é seguro de deixar público porque não é
utilizável como está.

Para travar a imagem em uma versão imutável em vez do canal `main` (mutável),
use `--image ghcr.io/roocodeinc/roomote-app:v<versão>` ou
`main-<sha>` (veja as tags publicadas em
[ghcr.io/roocodeinc/roomote-app](https://github.com/RooCodeInc/Roomote/pkgs/container/roomote-app)).

### 2. Crie o projeto no EasyPanel a partir do schema

No painel do EasyPanel, crie um projeto novo e use a opção de criar
serviços a partir de um schema/JSON (a redação exata do botão pode variar
entre versões do EasyPanel — procure por algo como "Create from Schema" ao
adicionar um novo serviço). Cole o conteúdo de `roomote.easypanel.json`.

Isso cria 9 serviços dentro do projeto:

| Serviço             | Tipo             | Domínio público             | Função                                             |
| -------------------- | ---------------- | ---------------------------- | --------------------------------------------------- |
| `<nome>-web`          | app              | sim, porta 3000              | Frontend / origem que os usuários abrem no navegador |
| `<nome>-api`          | app              | sim, porta 3001              | API/tRPC, webhooks do GitHub, chamadas dos workers   |
| `<nome>-controller`   | app              | não                          | Orquestra as tarefas / sandboxes Docker              |
| `<nome>-bullmq`       | app              | não (opcional, ver abaixo)   | Fila de jobs (BullMQ)                                |
| `<nome>-migrate`      | app              | não                          | Roda as migrações do banco (`db-migrate`)            |
| `<nome>-minio`        | app              | sim, porta 9000              | Armazenamento de artefatos compatível com S3         |
| `<nome>-docker-proxy` | app              | não                          | Proxy restrito do socket Docker do host              |
| `<nome>-db`           | postgres (nativo)| não                          | Banco de dados                                       |
| `<nome>-redis`        | redis (nativo)   | não                          | Cache / filas                                        |

### 3. Primeiro boot

1. Espere todos os serviços ficarem com status "rodando". **É normal** que
   `web`, `api`, `controller` e `bullmq` reiniciem algumas vezes no primeiro
   minuto — como o EasyPanel não tem um conceito de "espera até a migração
   terminar" (`depends_on`) para serviços de app, essas migrações rodam
   dentro do serviço `<nome>-migrate` em paralelo aos demais, e os outros se
   recuperam sozinhos assim que o banco estiver pronto.
2. Pegue o valor de `SETUP_TOKEN` no painel de variáveis de ambiente de
   qualquer um dos serviços de app (é o mesmo valor em todos).
3. Abra `https://<domínio-do-serviço-web>/setup?token=<SETUP_TOKEN>` e crie
   a conta de administrador (e-mail/senha funciona de imediato; login via
   Slack/Microsoft pode ser adicionado depois).
4. Conecte o GitHub pelo fluxo "Create GitHub App" (o assistente deriva as
   URLs de callback e webhook automaticamente a partir do domínio do `web` e
   do `api`).
5. Informe a chave do provedor de modelo quando o assistente pedir.
6. **Verifique a rede Docker** (ver seção abaixo) antes de rodar sua
   primeira tarefa.
7. Escolha os repositórios, crie um ambiente e rode uma tarefa simples de
   teste (ex.: peça a hora atual).

## Verifique o nome da rede Docker do projeto

O `controller` usa `DOCKER_WORKER_NETWORK` para descobrir os serviços `api`
(e o `preview-proxy`, se habilitado) e conectar os containers de tarefa a
essa mesma rede. O template define esse valor como `$(PROJECT_NAME)`
(a macro do próprio EasyPanel para o nome/slug do projeto), que é a
convenção mais comum, mas **confirme no servidor** antes de rodar tarefas:

```sh
docker network ls | grep <nome-do-projeto>
```

Se o nome real da rede overlay do projeto for diferente (por exemplo, com um
sufixo `_default`), edite a variável `DOCKER_WORKER_NETWORK` no serviço
`<nome>-controller` para o valor exato retornado pelo comando acima, e
reinicie o serviço.

Se os containers de tarefa não conseguirem inicializar depois de rodar uma
tarefa, esse é o primeiro lugar a verificar (mesma orientação que a
[documentação oficial do template Coolify](https://github.com/RooCodeInc/Roomote/blob/main/deploy/coolify/README.md)
do Roomote dá para o problema equivalente).

## O bucket de artefatos (MinIO)

O MinIO não cria buckets sozinho, então o template define
`S3_AUTO_CREATE_BUCKET=true`: no boot, o serviço `api` cria o bucket
`roomote-artifacts` se ele não existir. Acompanhe os logs do `api` por uma
linha como `[artifacts-bucket] Created S3 bucket ...` depois do primeiro
deploy.

As URLs pré-assinadas de artefato usam o domínio público do `minio`
(`S3_PRESIGN_ENDPOINT`), porque os workers de tarefa (containers Docker
"irmãos") só entram na rede da `api` (e do `preview-proxy`, se habilitado) —
nunca na rede dos bancos de dados. Alternativamente, você pode apontar as
variáveis `S3_*` para um armazenamento S3 externo (AWS S3 ou Cloudflare R2,
com `S3_REGION=auto` no caso do R2) e remover o serviço `minio`.

## Painel da fila (Bull Board)

O painel `/admin` do BullMQ (com controle de escrita sobre todas as filas)
só fica disponível quando `DASHBOARD_PASSWORD` está definido (o template já
gera um valor aleatório), atrás de autenticação HTTP básica com usuário
`admin`. Por padrão, o serviço `<nome>-bullmq` **não tem domínio público**
neste template — se quiser acessar o painel, adicione um domínio a esse
serviço na porta `3002` pelo próprio EasyPanel e use a senha de
`DASHBOARD_PASSWORD` (visível nas variáveis de ambiente do serviço).

## Sandboxes hospedados (sem socket do Docker)

Por padrão o template usa `DEFAULT_COMPUTE_PROVIDER=docker`, dando ao
`controller`/`bullmq` acesso (via o proxy) ao Docker do host — isso é
adequado para um servidor único e confiável, de único operador. Montar o
socket do Docker (mesmo por trás do proxy) dá controle efetivo sobre o
daemon Docker do host; não use esse modo em um host compartilhado com outras
cargas de trabalho não confiáveis.

Para usar sandboxes hospedados (Modal, E2B ou Daytona) em vez disso:

1. Nos serviços `<nome>-controller` e `<nome>-bullmq`, mude
   `DEFAULT_COMPUTE_PROVIDER` para `modal`, `e2b` ou `daytona`, e adicione
   `EXCLUDED_COMPUTE_PROVIDERS=docker`.
2. Você pode remover o serviço `<nome>-docker-proxy` e as variáveis
   `DOCKER_HOST`/`DOCKER_WORKER_NETWORK` nesse caso (não são mais usadas).
3. Mantenha `DOCKER_WORKER_RELEASE_PATH` — o controller ainda usa o release
   do worker empacotado na própria imagem para enviar aos sandboxes
   hospedados.
4. Informe as credenciais do provedor no assistente `/setup` depois do
   primeiro boot.

## Previews ao vivo (opcional)

Este template **não** inclui o serviço `preview-proxy` nem um domínio
curinga por padrão — previews de tarefa aparecem como "não configuradas" até
que isso seja feito manualmente. Habilitar previews exige um domínio
curinga (`*.preview.seu-dominio.com`) roteado para um serviço `preview-proxy`
extra rodando a imagem do Roomote com `command: preview-proxy`, escutando na
porta `8081`, com `PREVIEW_PROXY_BASE_URL`, `NEXT_PUBLIC_PREVIEW_PROXY_BASE_URL`
(esta última também no serviço `web`) e `PREVIEW_DOMAINS` apontando para
esse domínio. Veja a seção "Live previews" do
[README do template Coolify do Roomote](https://github.com/RooCodeInc/Roomote/blob/main/deploy/coolify/README.md#live-previews-optional)
para o passo a passo completo (a mecânica é a mesma, trocando a sintaxe de
domínio do Coolify pela do EasyPanel).

## Backups

No mínimo, faça backup de:

- O volume de dados do serviço `<nome>-db` (Postgres) — pode ser um
  `pg_dump` ou o volume inteiro.
- O volume `data` do serviço `<nome>-minio`.
- As variáveis de ambiente de cada serviço (senhas e chaves geradas) — o
  próprio EasyPanel permite exportar essas configurações.
- Opcionalmente, o volume do `<nome>-redis`, se precisar preservar filas e
  sessões entre perdas de host (não é dado de origem — tudo em Redis é
  reconstruível a partir do Postgres e das configurações).

## Licença e assentos

O Roomote é licenciado sob a Fair Core License 1.0. Um deploy é **grátis
para até 10 usuários**. Para mais usuários, adquira uma licença em
[cloud.roomote.dev](https://cloud.roomote.dev/sign-up) e informe a chave em
**Settings → Users → License** no próprio Roomote, ou defina
`R_LICENSE_KEY` no serviço `<nome>-migrate`/`<nome>-api`/etc. (o campo
`--license-key` do gerador já preenche isso em todos os serviços
relevantes).

## Atualizações

Para atualizar, mude a tag de imagem (`appServiceImage`/`--image`) nos
serviços `web`, `api`, `controller`, `bullmq` e `migrate`, e reimplante-os.
O serviço `<nome>-migrate` roda `db-migrate` novamente e aplica qualquer
migração pendente antes que a nova versão comece a atender tráfego de fato
(o Roomote garante que cada mudança de schema mantenha a versão anterior
funcionando, então uma migração com falha reverte automaticamente em uma
única transação).

## Limitações conhecidas deste template

- Sem `depends_on` nativo no EasyPanel: a sequência
  "migrar banco → depois subir os serviços de app" não é garantida — ver
  "Primeiro boot" acima.
- O serviço `<nome>-migrate` roda um comando que termina (não fica de pé
  como um processo de longa duração); dependendo da política de reinício do
  EasyPanel, ele pode reiniciar periodicamente. Isso é inofensivo (a
  migração usa um lock do Postgres e não faz nada em execuções repetidas),
  apenas gera ruído visual no painel.
- O nome exato da rede Docker do projeto (`DOCKER_WORKER_NETWORK`) pode
  variar entre instalações do EasyPanel — sempre confirme antes do primeiro
  uso (ver seção dedicada acima).
- Este template não é mantido pelo time do Roomote nem pela EasyPanel;
  reporte problemas específicos do template neste repositório, e problemas
  do próprio Roomote no [repositório oficial](https://github.com/RooCodeInc/Roomote/issues).

## Créditos

- [Roomote](https://github.com/RooCodeInc/Roomote) — projeto original,
  licenciado sob FCL-1.0.
- Topologia adaptada de
  [`deploy/coolify/docker-compose.yaml`](https://github.com/RooCodeInc/Roomote/blob/main/deploy/coolify/README.md),
  o template Docker Compose mantido oficialmente pelo time do Roomote para
  PaaS self-hosted equivalentes ao EasyPanel.
- Formato de template baseado em
  [easypanel-io/templates](https://github.com/easypanel-io/templates).
