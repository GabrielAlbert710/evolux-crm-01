// [fork Evolux IA] Prova comportamental de `prospecting_research` (migration 9001).
//
// A tabela segue a postura das irmãs da prospecção (`prospecting.test.ts`):
// exclusiva do servidor — RLS ligada, nenhuma policy, nenhum grant a
// anon/authenticated. A tela lê pela API, que filtra organization_id da sessão.
// Por isso a prova não é "lê 0 do vizinho" (o molde de TABLES), e sim "o JWT de
// um membro não lê nem grava nada, nem da própria org", mais a FK composta que
// impede pesquisa de uma org apontar para campanha/candidato de outra.
import { beforeAll, describe, expect, it } from "vitest";
import { countAs, sql, writeCountAs } from "./gov-helpers";

const ORG_A = "90010000-0000-4000-8000-00000000000a";
const ORG_B = "90010000-0000-4000-8000-00000000000b";
const MEMBRO_A = "90010000-1111-4000-8000-00000000000a";
const CAMPANHA_A = "90010000-2222-4000-8000-00000000000a";
const CAMPANHA_B = "90010000-2222-4000-8000-00000000000b";
const CANDIDATO_A = "90010000-3333-4000-8000-00000000000a";
const CANDIDATO_B = "90010000-3333-4000-8000-00000000000b";

beforeAll(() => {
  sql(`
    insert into auth.users (id, email) values ('${MEMBRO_A}', 'hunter-9001-a@invariant.test')
      on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'hunter-9001-a', 'Hunter A', 'Hunter A'),
      ('${ORG_B}', 'hunter-9001-b', 'Hunter B', 'Hunter B')
      on conflict (id) do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${MEMBRO_A}', '${ORG_A}', 'admin', now())
      on conflict do nothing;
    insert into public.prospecting_campaigns (id, organization_id, request_id, name, search) values
      ('${CAMPANHA_A}', '${ORG_A}', gen_random_uuid(), 'A', '{}'),
      ('${CAMPANHA_B}', '${ORG_B}', gen_random_uuid(), 'B', '{}');
    insert into public.prospecting_candidates (id, organization_id, campaign_id, place_id, data) values
      ('${CANDIDATO_A}', '${ORG_A}', '${CAMPANHA_A}', 'hunter-a', '{}'),
      ('${CANDIDATO_B}', '${ORG_B}', '${CAMPANHA_B}', 'hunter-b', '{}');
    insert into public.prospecting_research (organization_id, campaign_id, candidate_id) values
      ('${ORG_A}', '${CAMPANHA_A}', '${CANDIDATO_A}'),
      ('${ORG_B}', '${CAMPANHA_B}', '${CANDIDATO_B}');
  `);
});

describe("prospecting_research — exclusiva do servidor e cercada por organização", () => {
  it("RLS ligada e nenhum privilégio de anon/authenticated", () => {
    expect(
      sql(
        "select relrowsecurity from pg_class where oid = 'public.prospecting_research'::regclass",
      ),
    ).toBe("t");
    expect(
      sql(
        `select bool_and(not has_table_privilege(r, 'public.prospecting_research', o))
           from unnest(array['anon','authenticated']) r
          cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE']) o`,
      ),
    ).toBe("t");
  });

  it("controle: as duas organizações têm linha semeada", () => {
    expect(
      sql(
        `select count(distinct organization_id) from public.prospecting_research
          where organization_id in ('${ORG_A}','${ORG_B}')`,
      ),
    ).toBe("2");
  });

  it("JWT de um membro não lê nada — nem do vizinho, nem da própria org", () => {
    expect(() =>
      countAs(
        MEMBRO_A,
        `select count(*) from public.prospecting_research where organization_id = '${ORG_B}';`,
      ),
    ).toThrow(/permission denied/);
    expect(() =>
      countAs(
        MEMBRO_A,
        `select count(*) from public.prospecting_research where organization_id = '${ORG_A}';`,
      ),
    ).toThrow(/permission denied/);
  });

  it("JWT de um membro não grava, não altera e não apaga", () => {
    for (const dml of [
      `insert into public.prospecting_research (organization_id, campaign_id, candidate_id)
         values ('${ORG_A}', '${CAMPANHA_A}', '${CANDIDATO_A}')`,
      `update public.prospecting_research set status = 'failed' where organization_id = '${ORG_B}'`,
      `delete from public.prospecting_research where organization_id = '${ORG_B}'`,
    ]) {
      expect(() => writeCountAs(MEMBRO_A, dml)).toThrow(/permission denied/);
    }
    expect(
      sql(
        `select count(*) from public.prospecting_research where organization_id = '${ORG_B}' and status = 'pending'`,
      ),
    ).toBe("1");
  });

  it("FK composta recusa pesquisa de uma org apontando para campanha de outra", () => {
    expect(() =>
      sql(
        `insert into public.prospecting_research (organization_id, campaign_id, candidate_id)
           values ('${ORG_A}', '${CAMPANHA_B}', '${CANDIDATO_B}')`,
      ),
    ).toThrow();
  });
});
