/**
 * [fork Evolux] Hunter — pesquisa de prospect (docs/evolux/hunter.md).
 *
 * Mede as regras que NÃO podem depender de o modelo obedecer ao prompt
 * (saneamento), a idempotência do job e a fronteira: o Hunter não envia,
 * não agenda, não mexe em funil e não busca na Apify.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi, beforeEach } from "vitest";

const auditMock = vi.fn();
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => auditMock(...a) }));
vi.mock("@/lib/env", () => ({ env: {} }));
const runModelCallMock = vi.fn();
vi.mock("@/lib/agent-engine/edge/llm/run-model-call", () => ({
  runModelCall: (...a: unknown[]) => runModelCallMock(...a),
  llmEdgeConfigFromEnv: () => ({}),
}));

import { HUNTER_PROMPT_VERSION } from "@/lib/prospecting/hunter/prompt";
import { hunterModelOutputSchema, hunterResearchSchema } from "@/lib/prospecting/hunter/schema";
import {
  completudeDosDados,
  extrairJson,
  faixaDoIcp,
  sanearSaida,
  tetoDeConfianca,
  type EntradaDoHunter,
} from "@/lib/prospecting/hunter/saneamento";
import {
  analisarPesquisa,
  chamarModeloPadrao,
  enfileirarPesquisas,
  type ChamarModelo,
  type LinhaDePesquisa,
} from "@/lib/prospecting/hunter/worker";

const completa: EntradaDoHunter = {
  empresa: {
    name: "Clínica Sorriso Ilha",
    category: "Dentista",
    address: "Av. dos Holandeses, 100 - São Luís, MA",
    phone: "+55 98 99999-0000",
    website: "https://sorrisoilha.com.br/",
    maps_url: "https://maps.google.com/?cid=1",
    rating: 4.8,
    reviews: 312,
    emails: ["contato@sorrisoilha.com.br"],
    socials: ["https://instagram.com/sorrisoilha"],
  },
  campanha: { niche: "Clínicas odontológicas", location: "São Luís, MA" },
};
const pobre: EntradaDoHunter = {
  empresa: {
    name: "Consultório X",
    category: null,
    address: null,
    phone: null,
    website: null,
    maps_url: null,
    rating: null,
    reviews: null,
    emails: [],
    socials: [],
  },
  campanha: { niche: "Clínicas odontológicas", location: "São Luís, MA" },
};

const saida = (parcial: Record<string, unknown> = {}) =>
  hunterModelOutputSchema.parse({
    company: "Clínica Sorriso Ilha",
    segment: "Saúde",
    subsegment: "Odontologia",
    location: "São Luís, MA",
    website: "https://sorrisoilha.com.br",
    contact_channels: { phone: "+55 98 99999-0000", whatsapp: null, email: null, social: [] },
    facts: [{ statement: "Tem 312 avaliações no Google.", source: "reviews", evidence: "312" }],
    hypotheses: [],
    pain_signals: [],
    opportunity_signals: ["Alto volume de avaliações"],
    possible_contacts: [],
    score_breakdown: {
      segment_fit: 18,
      digital_channels: 12,
      opportunity_signals: 14,
      automation_potential: 12,
      contactability: 7,
      data_quality: 8,
      campaign_match: 5,
    },
    confidence: 0.7,
    recommended_angle: "atendimento via WhatsApp",
    disqualifiers: [],
    recommended_next_action: "Abordar e confirmar como os atendimentos são organizados.",
    research_summary: "Clínica com boa presença digital.",
    ...parcial,
  });

describe("saneamento — o Hunter não inventa", () => {
  it("1. fato sem evidência nos dados vira hipótese, nunca o contrário", () => {
    const r = sanearSaida(
      saida({
        facts: [
          { statement: "Tem 312 avaliações no Google.", source: "reviews", evidence: "312" },
          { statement: "Perde pacientes por falta de follow-up.", source: "website", evidence: "perde pacientes" },
          { statement: "Usa o sistema Y.", source: "linkedin", evidence: "Y" },
        ],
        hypotheses: [{ statement: "Pode ter volume alto no WhatsApp.", confidence: 0.5, how_to_validate: "Perguntar." }],
      }),
      completa,
    );
    expect(r.facts.map((f) => f.statement)).toEqual(["Tem 312 avaliações no Google."]);
    expect(r.hypotheses.map((h) => h.statement)).toEqual(
      expect.arrayContaining(["Perde pacientes por falta de follow-up.", "Usa o sistema Y.", "Pode ter volume alto no WhatsApp."]),
    );
    expect(r.facts.some((f) => r.hypotheses.some((h) => h.statement === f.statement))).toBe(false);
  });

  it("2. decisor sem evidência vira UNKNOWN e não cria pessoa", () => {
    const r = sanearSaida(
      saida({
        possible_contacts: [
          { name: "Dr. João Silva", role: "Diretor clínico", contact_role: "DECISION_MAKER", source: "website", confidence: 0.9 },
          { name: null, role: null, contact_role: "GATEKEEPER", source: null, confidence: 0.6 },
        ],
      }),
      completa,
    );
    expect(r.responsible_person).toBe("UNKNOWN");
    expect(r.possible_contacts.every((c) => c.name === null && c.role === null)).toBe(true);
    expect(r.possible_contacts.every((c) => c.contact_role === "UNKNOWN")).toBe(true);
    expect(r.possible_contacts).toHaveLength(1);
  });

  it("2b. pessoa que aparece nos dados é mantida", () => {
    const comNome = { ...completa, empresa: { ...completa.empresa, name: "Clínica Dra. Ana Lima" } };
    const r = sanearSaida(
      saida({
        possible_contacts: [
          { name: "Dra. Ana Lima", role: null, contact_role: "DECISION_MAKER", source: "name", confidence: 0.6 },
        ],
      }),
      comNome,
    );
    expect(r.responsible_person).toBe("Dra. Ana Lima");
  });

  it("3. sem e-mail nos dados, nenhum e-mail é fabricado", () => {
    const r = sanearSaida(
      saida({ contact_channels: { phone: null, whatsapp: "+55 98 90000-1111", email: "contato@consultoriox.com", social: ["https://instagram.com/inventado"] } }),
      pobre,
    );
    expect(r.contact_channels.email).toBeNull();
    expect(r.contact_channels.whatsapp).toBeNull();
    expect(r.contact_channels.phone).toBeNull();
    expect(r.contact_channels.social).toEqual([]);
    expect(r.corrections.length).toBeGreaterThan(0);
  });

  it("3b. canais que estão nos dados sobrevivem", () => {
    const r = sanearSaida(
      saida({ contact_channels: { phone: "98 99999-0000", whatsapp: "(98) 99999-0000", email: "CONTATO@sorrisoilha.com.br", social: ["instagram.com/sorrisoilha/"] } }),
      completa,
    );
    expect(r.contact_channels).toEqual({
      phone: "+55 98 99999-0000",
      whatsapp: "(98) 99999-0000",
      email: "contato@sorrisoilha.com.br",
      social: ["https://instagram.com/sorrisoilha"],
    });
  });

  it("3c. link wa.me gravado como site vale como WhatsApp; inventado não", () => {
    const comWa = { ...completa, empresa: { ...completa.empresa, website: "https://wa.me/message/ABC123" } };
    expect(
      sanearSaida(saida({ contact_channels: { phone: null, whatsapp: "https://wa.me/message/ABC123", email: null, social: [] } }), comWa)
        .contact_channels.whatsapp,
    ).toBe("https://wa.me/message/ABC123");
    expect(
      sanearSaida(saida({ contact_channels: { phone: null, whatsapp: "https://wa.me/message/OUTRO", email: null, social: [] } }), comWa)
        .contact_channels.whatsapp,
    ).toBeNull();
  });

  it("4. dor confirmada é rebaixada para POTENTIAL_PAIN", () => {
    const r = sanearSaida(
      saida({ pain_signals: [{ statement: "Demora para responder.", status: "PAIN_CONFIRMED" }, "Agenda manual"] }),
      completa,
    );
    expect(r.pain_signals.every((p) => p.status === "POTENTIAL_PAIN")).toBe(true);
    expect(r.pain_signals).toHaveLength(2);
  });

  it("5. score fica entre 0 e 100 e a faixa sai do score, não do modelo", () => {
    const r = sanearSaida(
      saida({
        score_breakdown: {
          segment_fit: 999,
          digital_channels: 999,
          opportunity_signals: 999,
          automation_potential: 999,
          contactability: 999,
          data_quality: 999,
          campaign_match: 999,
        },
      }),
      completa,
    );
    expect(r.icp_score).toBe(100);
    expect(r.icp_tier).toBe("HIGH_FIT");
    const negativo = sanearSaida(saida({ score_breakdown: { segment_fit: -50 } }), completa);
    expect(negativo.icp_score).toBeGreaterThanOrEqual(0);
    expect(faixaDoIcp(79)).toBe("MEDIUM_FIT");
    expect(faixaDoIcp(64)).toBe("LOW_FIT");
  });

  it("6. dados insuficientes reduzem a confiança", () => {
    expect(completudeDosDados(pobre.empresa)).toBe(0);
    const r = sanearSaida(saida({ confidence: 0.95 }), pobre);
    expect(r.confidence).toBe(tetoDeConfianca(0));
    expect(r.confidence).toBeLessThan(sanearSaida(saida({ confidence: 0.95 }), completa).confidence);
    expect(r.confidence).toBeGreaterThanOrEqual(0);
    expect(r.confidence).toBeLessThanOrEqual(1);
  });

  it("proveniência é de pesquisa, nunca de declaração do cliente", () => {
    const r = sanearSaida(saida(), completa);
    expect(r.provenance).toBe("prospecting_source");
    expect(() => hunterResearchSchema.parse({ ...r, provenance: "customer_statement" })).toThrow();
  });

  it("extrai o JSON mesmo embrulhado em markdown", () => {
    expect(extrairJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(() => extrairJson("sem json")).toThrow();
  });
});

describe("fronteira — o Hunter não fala com ninguém", () => {
  const fonte = ["worker.ts", "saneamento.ts", "schema.ts", "prompt.ts"]
    .map((f) => readFileSync(`lib/prospecting/hunter/${f}`, "utf8"))
    .join("\n");
  const imports = [...fonte.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]!);

  it("7. não importa nada de envio de mensagem ou canal", () => {
    expect(imports.filter((i) => /messag|whatsapp|waha|channel|send|outbound|inbox/i.test(i))).toEqual([]);
  });
  it("8. não importa nada de agenda", () => {
    expect(imports.filter((i) => /calendar|agenda|appointment|booking/i.test(i))).toEqual([]);
  });
  it("9. não importa nada que altere funil ou etapa", () => {
    expect(imports.filter((i) => /pipeline|stage|crm|lead/i.test(i))).toEqual([]);
  });
  it("não busca na Apify: só reaproveita as empresas já gravadas", () => {
    expect(imports.filter((i) => /provider|provedor|apify|store/i.test(i))).toEqual([]);
    expect(fonte).not.toMatch(/api\.apify\.com|startSearch|createSearch/);
    expect(fonte).toMatch(/from prospecting_candidates p/);
  });
  it("a chamada de modelo vai SEM ferramentas", async () => {
    runModelCallMock.mockResolvedValueOnce({
      result: { text: "{}" },
      callId: "c1",
      provider: "anthropic",
      model: "m",
      costCents: 1,
      usage: {},
    });
    await chamarModeloPadrao({} as never)({ org: "o", entrada: completa });
    const input = runModelCallMock.mock.calls[0]![2] as Record<string, unknown>;
    expect(input.tools).toBeUndefined();
    expect(input.purpose).toBe("prospecting_research");
  });
});

describe("job — idempotente e sem duplicar", () => {
  type Q = { sql: string; params: unknown[] };
  let queries: Q[];
  const linha: LinhaDePesquisa = {
    id: "r1",
    organization_id: "org",
    campaign_id: "camp",
    candidate_id: "cand",
    correlation_id: "corr",
    attempts: 1,
  };
  function banco(rowCountDoUpdate = 1) {
    return {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        queries.push({ sql, params });
        if (/from prospecting_candidates p/.test(sql))
          return {
            rows: [{ data: { ...completa.empresa }, phone: completa.empresa.phone, search: completa.campanha }],
            rowCount: 1,
          };
        if (/^\s*update prospecting_research/.test(sql)) return { rows: [], rowCount: rowCountDoUpdate };
        return { rows: [], rowCount: 0 };
      }),
    } as never;
  }
  const chamar: ChamarModelo = async () => ({
    texto: JSON.stringify(saida()),
    callId: "call-1",
    provider: "anthropic",
    model: "claude",
    costCents: 2,
    usage: { input_tokens: 10 },
  });
  beforeEach(() => {
    queries = [];
    auditMock.mockReset();
  });

  it("10. enfileirar é insert com on conflict — repetir não duplica", async () => {
    const db = banco();
    await enfileirarPesquisas(db, "org", "camp");
    expect(queries[0]!.sql).toMatch(/on conflict \(organization_id, candidate_id\) do update/);
    expect(queries[0]!.sql).toMatch(/where \$5::boolean/);
    expect(queries[0]!.params[4]).toBe(false);
  });

  it("concluir grava na MESMA linha, guardado por correlation_id e status, e audita", async () => {
    const db = banco(1);
    const r = await analisarPesquisa(db, linha, chamar);
    expect(r.ok).toBe(true);
    expect(queries.some((q) => /insert/i.test(q.sql))).toBe(false);
    const upd = queries.find((q) => /set status = 'completed'/.test(q.sql))!;
    expect(upd.sql).toMatch(/correlation_id = \$3 and status = 'processing'/);
    expect(upd.params.slice(0, 3)).toEqual(["org", "r1", "corr"]);
    expect(auditMock).toHaveBeenCalledTimes(1);
    const meta = auditMock.mock.calls[0]![0].metadata;
    expect(meta).toMatchObject({ correlation_id: "corr", llm_call_id: "call-1", prompt_version: HUNTER_PROMPT_VERSION, model: "claude" });
  });

  it("retry atrasado (linha já não é dele) não sobrescreve nem audita", async () => {
    const db = banco(0);
    await analisarPesquisa(db, linha, chamar);
    expect(auditMock).not.toHaveBeenCalled();
    expect(queries.some((q) => /insert/i.test(q.sql))).toBe(false);
  });

  it("falha com tentativa sobrando volta para a fila; na última, FAILED", async () => {
    const quebrado: ChamarModelo = async () => ({ ...(await chamar({} as never)), texto: "não é json" });
    let db = banco();
    let r = await analisarPesquisa(db, linha, quebrado);
    expect(r).toMatchObject({ ok: false, definitivo: false });
    expect(queries.at(-1)!.params[3]).toBe("pending");
    queries = [];
    db = banco();
    r = await analisarPesquisa(db, { ...linha, attempts: 3 }, quebrado);
    expect(r).toMatchObject({ ok: false, definitivo: true });
    expect(queries.find((q) => /set status = \$4/.test(q.sql))!.params[3]).toBe("failed");
    expect(auditMock.mock.calls[0]![0].action).toBe("prospecting.research_failed");
  });
});
