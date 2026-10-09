# Fork Evolux IA do DeskcommCRM

> O CRM base do Evolux SDR **é** o DeskcommCRM (<https://github.com/melgarafael/DeskcommCRM>).
> Não existe CRM separado nem aplicação paralela: a Evolux mantém um **fork** e customiza nele,
> respeitando `CLAUDE.md`, `ARCHITECTURE.md` e `CONTRIBUTING.md` do projeto oficial.

## Regras do fork

1. **Reuse first.** Agentes, pontos de IA, RAG, MCP, Supabase, workers/cron, auditoria, filas,
   WhatsApp e capacidades do Deskcomm são reaproveitados; nada de infraestrutura paralela.
2. **Customização isolada.** Código novo em pastas próprias (`lib/prospecting/hunter/`,
   `_hunter.tsx`, `app/api/v1/prospecting/research/`); nos arquivos oficiais, só acréscimos
   pequenos e marcados com `[fork Evolux]`, para o merge com o oficial ser previsível.
3. **Migrations do fork na faixa 9xxx** (ex.: `9001`), para nunca colidir com o `NNNN` sequencial
   do oficial. Mesma tripla de sempre: arquivo em `migrations/` + apêndice no `baseline.sql` +
   `-- manifest:` no cabeçalho.
4. **Sem PR ao oficial** por enquanto. O que for genérico pode virar contribuição depois.
5. **Sem "Atualizar agora"** na instalação do fork (ver "Atualização").

## Remotos

```bash
git remote -v
# upstream  https://github.com/melgarafael/DeskcommCRM.git   (fetch; push bloqueado)
# origin    https://github.com/<conta-evolux>/<fork>.git     (fetch/push)
```

`upstream` tem a URL de push trocada por `NAO_ENVIAR_PARA_O_OFICIAL` para nada sair para lá por
engano. Branches do fork: `evolux/<assunto>`; tags de imagem: `evolux-vX.Y.Z`.

## Imagens (GitHub Actions)

`.github/workflows/evolux-imagem.yml` — em push de `evolux/**` ou tag `evolux-v*`:

1. **verificar**: `pnpm typecheck`, `pnpm lint`, `pnpm test:unit` (suíte inteira) e `pnpm test:db`
   (baseline install + update + invariantes de RLS). É aqui que o fork é verificado: a VPS
   (1 vCPU / 4 GB) não comporta essas etapas.
2. **imagens**: publica, só se o passo 1 passar, `ghcr.io/<dono>/deskcommcrm-evolux`,
   `deskcomm-worker-evolux` e `deskcomm-scheduler-evolux` (amd64), com tags imutáveis
   `evolux-<sha7>` (e `X.Y.Z` numa tag `evolux-vX.Y.Z`).

No GitHub do fork, **desative os workflows oficiais** que não fazem sentido lá (Actions → cada
workflow → *Disable*): `publish-image.yml`, `release.yml`, `relogio.yml` (tem agendamento),
`acolhida.yml`, `vigia-de-colisao.yml`, `e2e.yml`, `perf.yml`, `ci.yml`. Ativo fica só
`evolux-imagem.yml`. Os pacotes do GHCR nascem privados: a VPS precisa de `docker login ghcr.io`
com um token de leitura de pacotes.

## Ambientes

| ambiente | onde | banco | estado |
|---|---|---|---|
| produção | VPS atual, `crm.evoluxia.agenteortoimplante.tech` | Supabase de produção | imagem **oficial** 1.78.0 + tabela `prospecting_research` (migration 9001 já aplicada) |
| HML | a definir | Supabase **separado** | a criar — primeiro destino da imagem do fork |

HML nunca usa o banco de produção: um deploy de teste não pode escrever em dados reais.

## Atualização

O botão "Atualizar agora" e `hostgator-setup-kit/update.sh` regravam `APP_IMAGE` para a imagem
**oficial**: numa instalação do fork, isso tiraria o Hunter do ar. Até existir uma estratégia
própria, a atualização do fork é:

```bash
git fetch upstream --tags
git switch evolux/<branch> && git merge vX.Y.Z      # merge, nunca rebase/force
git push origin evolux/<branch>                     # o Actions verifica e publica
# na VPS: APP_IMAGE/WORKER_IMAGE/SCHEDULER_IMAGE = ...-evolux:evolux-<sha7>
```

Pontos de conflito esperados no merge: fim de `lib/audit/actions.ts`, fim de
`lib/i18n/dicionario.ts`, `lib/ai/pontos/registro.ts`, `app/api/v1/cron/prospecting/route.ts`,
3 linhas de `app/app/prospecting/_client.tsx`, mapa de `tests/unit/gatilho-dos-jobs-de-entrega.test.ts`
e `docs/architecture/prospeccao-nativa.architecture.json`.

## Customizações

- [Hunter — inteligência comercial](hunter.md)
