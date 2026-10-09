-- manifest: [fork Evolux] Hunter — pesquisa de prospect (prospecting_research): uma linha por empresa encontrada, com status do job, saída validada, ICP, confiança e proveniência de PESQUISA (nunca dado declarado pelo cliente)
--
-- FORK EVOLUX IA. Número 9001 de propósito: fica fora da faixa sequencial do
-- projeto oficial (06xx em 10/2026), para que uma sincronização futura com a
-- main de lá não colida no NNNN. Ver docs/evolux/hunter.md.
--
-- Mesma postura das tabelas da prospecção (0370 e anteriores): RLS ligada,
-- sem policy, só service_role. A tela lê pela API, que filtra organization_id
-- resolvido da sessão.

create table if not exists public.prospecting_research (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  campaign_id uuid not null,
  candidate_id uuid not null references public.prospecting_candidates(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending','processing','completed','failed')),
  -- De onde vieram os dados analisados. Pesquisa NUNCA é 'customer_statement'.
  provenance text not null default 'prospecting_source'
    check (provenance in ('prospecting_source','public_source','research')),
  correlation_id uuid not null default gen_random_uuid(),
  result jsonb,
  icp_score integer check (icp_score between 0 and 100),
  icp_tier text check (icp_tier in ('HIGH_FIT','MEDIUM_FIT','LOW_FIT')),
  confidence numeric(3,2) check (confidence between 0 and 1),
  prompt_version text,
  provider text,
  model text,
  llm_call_id uuid,
  input_hash text,
  attempts integer not null default 0,
  error text,
  requested_by uuid,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organization_id, campaign_id)
    references public.prospecting_campaigns(organization_id, id) on delete cascade,
  unique (organization_id, candidate_id)
);

create index if not exists prospecting_research_fila
  on public.prospecting_research(organization_id, status, updated_at)
  where status in ('pending','processing');
create index if not exists prospecting_research_campanha
  on public.prospecting_research(organization_id, campaign_id);

alter table public.prospecting_research enable row level security;
revoke all on public.prospecting_research from public, anon, authenticated;
grant all on public.prospecting_research to service_role;
notify pgrst, 'reload schema';
