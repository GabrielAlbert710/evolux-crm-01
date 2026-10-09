# Hunter — inteligência comercial (fork Evolux IA)

> Ver também [o fork](fork.md). Mudança **do fork Evolux IA**, fora do projeto oficial DeskcommCRM. Branch: `evolux/hunter`,
> criada a partir da tag `v1.78.0`. Nenhum pull request foi aberto no projeto oficial.

## O que é

O Hunter analisa as empresas que a **Prospecção** já encontrou (dados da Apify gravados em
`prospecting_candidates.data`) e grava, para cada uma: fatos (com campo de origem e evidência),
hipóteses (com confiança e como validar), sinais de oportunidade, dores **potenciais**, possíveis
contatos, ICP (0–100, soma de 7 critérios), faixa (`HIGH_FIT` ≥ 80, `MEDIUM_FIT` ≥ 65, `LOW_FIT`),
confiança (0–1), ângulo recomendado, próxima ação e resumo.

Ele **não** é um agente de WhatsApp: não tem número, não entra no roteamento, não responde Inbox,
não envia mensagem, não agenda, não mexe em funil e não busca na Apify. A chamada de modelo vai
**sem ferramentas**. Isso é cobrado por teste (`tests/unit/evolux-hunter.test.ts`, bloco "fronteira").

## Como funciona

```
Prospecção (busca concluída)
  → prospecting_research (status pending)          ← automático, ou botão "Analisar empresas"
  → cron /api/v1/cron/prospecting (1×/min)          ← tickHunter: até 2 por batida
  → reivindica (processing, for update skip locked)
  → carrega empresa + campanha (só leitura)
  → modelo (ponto de IA "prospecting_research", sem ferramentas)
  → valida JSON (Zod) → saneamento anti-invenção → grava (completed)
  → auditoria prospecting.research_completed | research_failed
```

- **Fila durável = a própria tabela.** `unique (organization_id, candidate_id)`: repetir não duplica;
  reanalisar reaproveita a mesma linha com `correlation_id` novo. Concluir só grava se a linha ainda
  estiver `processing` com o mesmo `correlation_id` (retry atrasado não sobrescreve).
- **Falhas:** até 3 tentativas (volta para `pending`); na terceira, `failed` + auditoria.
- **Automático:** toda empresa de busca concluída entra na fila. Para desligar numa organização:
  `organizations.settings.prospecting.hunter_auto = false`.
- **Modelo:** ponto de IA `prospecting_research`. Sem escolha, usa o padrão da organização
  (hoje Claude Sonnet). Troca-se em **IA › Provedores** (nenhum modelo fixo no código).
- **Custo:** cada análise vai para `llm_calls` (tela de Execuções/custos). Medido: ~US$ 0,05 por empresa
  com Claude Sonnet.
- **Proveniência:** `provenance = 'prospecting_source'` na linha e no JSON. Pesquisa **nunca** é gravada
  como dado declarado pelo cliente (não usa `crm_propose_contact_field`).

### O saneamento (`lib/prospecting/hunter/saneamento.ts`)

Regras reaplicadas depois da resposta, independentes do prompt:

| regra | efeito |
|---|---|
| canal de contato fora dos dados | vira `null` (telefone, WhatsApp, e-mail, rede) |
| fact sem campo de origem válido ou sem a evidência no campo | rebaixado a hipótese |
| pessoa/cargo que não aparece literalmente nos dados | descartado; papel vira `UNKNOWN` |
| dor `PAIN_CONFIRMED` | rebaixada para `POTENTIAL_PAIN` |
| critério do ICP acima do teto | cortado no teto; ICP = soma; faixa calculada no código |
| confiança | teto pela completude dos dados (0,3 sem dados → 0,9 com tudo) |

Toda correção fica em `result.corrections`.

## Arquivos

| arquivo | o quê |
|---|---|
| `supabase/migrations/20261009140000_9001_evolux_hunter_pesquisa_de_prospect.sql` | tabela `prospecting_research` (número 9001: fora da faixa do oficial) |
| `supabase/baseline.sql` | mesmo bloco no fim (apêndice idempotente) |
| `lib/prospecting/hunter/{prompt,schema,saneamento,worker}.ts` | o Hunter |
| `app/api/v1/prospecting/research/route.ts` | GET análises / POST `analyze` (rota nova, a oficial não muda) |
| `app/api/v1/cron/prospecting/route.ts` | +1 chamada a `tickHunter` |
| `app/app/prospecting/_hunter.tsx` + 3 linhas em `_client.tsx` | barra da campanha + análise por empresa |
| `lib/ai/pontos/registro.ts` | ponto `prospecting_research` |
| `lib/audit/actions.ts` | `prospecting.research_{requested,completed,failed}` |
| `lib/i18n/dicionario.ts` | espanhol dos textos novos |
| `scripts/evolux-hunter-analisar.ts` | rodar à mão |
| `tests/unit/evolux-hunter.test.ts` | testes |
| `tsconfig.hunter.json` | typecheck só dos arquivos tocados (a VPS de 4 GB não comporta o typecheck inteiro) |

## Rodar à mão

```bash
pnpm tsx scripts/evolux-hunter-analisar.ts <campaign_id> [quantas] [--forcar]
```

## Publicar (ainda NÃO feito)

A VPS de produção roda as imagens do projeto oficial. O Hunter só entra no ar com as imagens do
fork, geradas pelo GitHub Actions (`deskcommcrm-evolux`, `deskcomm-worker-evolux`,
`deskcomm-scheduler-evolux`, tag `evolux-<sha7>`), e **primeiro no HML**, com Supabase separado.
Produção só depois de aprovado no HML. Passo a passo, ambientes e a regra de não usar
"Atualizar agora": [o fork](fork.md).

## Sincronizar com o oficial depois

```bash
git fetch upstream --tags
git merge v1.79.0        # merge, nunca rebase/force
pnpm vitest run tests/unit/evolux-hunter.test.ts tests/unit/pontos-de-ia-completude.test.ts
```

Pontos de conflito prováveis: ver [o fork](fork.md#atualização).

## Contrato para Atlas e Maya

Leiam `prospecting_research` com `status = 'completed'`; o formato de `result` é
`hunterResearchSchema` (`lib/prospecting/hunter/schema.ts`). Atlas decide com `icp_score`,
`icp_tier`, `confidence`, `disqualifiers`; Maya escreve com `facts`, `recommended_angle` e
`research_summary` — **nunca** com `hypotheses` como se fossem fatos.
