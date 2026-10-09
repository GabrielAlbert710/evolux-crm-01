/**
 * [fork Evolux] O contrato da saída do Hunter — o que o modelo devolve
 * (`hunterModelOutputSchema`, tolerante) e o que o CRM grava
 * (`hunterResearchSchema`, estrito, depois de `sanearSaida`).
 *
 * É este segundo formato que Atlas e Maya vão consumir: mude com cuidado e
 * suba `HUNTER_PROMPT_VERSION` junto.
 */
import { z } from "zod";

/** Os campos de `prospecting_candidates.data` que um fact pode citar como fonte. */
export const CAMPOS_DE_ORIGEM = [
  "name",
  "category",
  "address",
  "phone",
  "website",
  "emails",
  "socials",
  "rating",
  "reviews",
  "maps_url",
] as const;

export const PAPEIS_DE_CONTATO = ["DECISION_MAKER", "INFLUENCER", "GATEKEEPER", "UNKNOWN"] as const;

/** Tetos de cada critério do ICP — a soma é 100. */
export const TETOS_DO_ICP = {
  segment_fit: 20,
  digital_channels: 15,
  opportunity_signals: 20,
  automation_potential: 20,
  contactability: 10,
  data_quality: 10,
  campaign_match: 5,
} as const;
export type CriterioDoIcp = keyof typeof TETOS_DO_ICP;

const texto = (max: number) => z.string().trim().max(max);
const numeroSolto = z.coerce.number().catch(0);

/** O que o modelo devolve. Tolerante: o saneamento corrige, o parse não rejeita por detalhe. */
export const hunterModelOutputSchema = z.object({
  company: texto(300).catch(""),
  segment: texto(200).catch(""),
  subsegment: texto(200).catch(""),
  location: texto(300).catch(""),
  website: z.string().max(500).nullable().catch(null),
  contact_channels: z
    .object({
      phone: z.string().max(100).nullable().catch(null),
      whatsapp: z.string().max(100).nullable().catch(null),
      email: z.string().max(300).nullable().catch(null),
      social: z.array(z.string().max(500)).max(20).catch([]),
    })
    .catch({ phone: null, whatsapp: null, email: null, social: [] }),
  facts: z
    .array(
      z.object({
        statement: texto(600),
        source: texto(100).nullable().catch(null),
        evidence: texto(600).nullable().catch(null),
      }),
    )
    .max(30)
    .catch([]),
  hypotheses: z
    .array(
      z.object({
        statement: texto(600),
        confidence: numeroSolto,
        how_to_validate: texto(600).catch(""),
      }),
    )
    .max(30)
    .catch([]),
  pain_signals: z
    .array(
      z.union([
        z.object({ statement: texto(600), status: z.string().catch("POTENTIAL_PAIN") }),
        texto(600).transform((statement) => ({ statement, status: "POTENTIAL_PAIN" })),
      ]),
    )
    .max(20)
    .catch([]),
  opportunity_signals: z.array(texto(600)).max(20).catch([]),
  possible_contacts: z
    .array(
      z.object({
        name: z.string().max(200).nullable().catch(null),
        role: z.string().max(200).nullable().catch(null),
        contact_role: z.string().catch("UNKNOWN"),
        source: z.string().max(200).nullable().catch(null),
        confidence: numeroSolto,
      }),
    )
    .max(10)
    .catch([]),
  score_breakdown: z
    .object({
      segment_fit: numeroSolto,
      digital_channels: numeroSolto,
      opportunity_signals: numeroSolto,
      automation_potential: numeroSolto,
      contactability: numeroSolto,
      data_quality: numeroSolto,
      campaign_match: numeroSolto,
    })
    .catch({
      segment_fit: 0,
      digital_channels: 0,
      opportunity_signals: 0,
      automation_potential: 0,
      contactability: 0,
      data_quality: 0,
      campaign_match: 0,
    }),
  confidence: numeroSolto,
  recommended_angle: texto(600).catch(""),
  disqualifiers: z.array(texto(400)).max(20).catch([]),
  recommended_next_action: texto(600).catch(""),
  research_summary: texto(2000).catch(""),
});
export type HunterModelOutput = z.infer<typeof hunterModelOutputSchema>;

const confianca = z.number().min(0).max(1);

/** O que o CRM grava — estrito. Atlas e Maya leem ESTE formato. */
export const hunterResearchSchema = z
  .object({
    company: z.string(),
    segment: z.string(),
    subsegment: z.string(),
    location: z.string(),
    website: z.string().nullable(),
    contact_channels: z.object({
      phone: z.string().nullable(),
      whatsapp: z.string().nullable(),
      email: z.string().nullable(),
      social: z.array(z.string()),
    }),
    facts: z.array(
      z.object({
        statement: z.string().min(1),
        source: z.enum(CAMPOS_DE_ORIGEM),
        evidence: z.string().min(1),
      }),
    ),
    hypotheses: z.array(
      z.object({ statement: z.string().min(1), confidence: confianca, how_to_validate: z.string() }),
    ),
    pain_signals: z.array(
      z.object({ statement: z.string().min(1), status: z.literal("POTENTIAL_PAIN") }),
    ),
    opportunity_signals: z.array(z.string()),
    possible_contacts: z.array(
      z.object({
        name: z.string().nullable(),
        role: z.string().nullable(),
        contact_role: z.enum(PAPEIS_DE_CONTATO),
        source: z.string().nullable(),
        confidence: confianca,
      }),
    ),
    responsible_person: z.string(),
    score_breakdown: z.object(
      Object.fromEntries(
        Object.entries(TETOS_DO_ICP).map(([k, teto]) => [k, z.number().int().min(0).max(teto)]),
      ) as Record<CriterioDoIcp, z.ZodNumber>,
    ),
    icp_score: z.number().int().min(0).max(100),
    icp_tier: z.enum(["HIGH_FIT", "MEDIUM_FIT", "LOW_FIT"]),
    confidence: confianca,
    recommended_angle: z.string(),
    disqualifiers: z.array(z.string()),
    recommended_next_action: z.string(),
    research_summary: z.string(),
    provenance: z.literal("prospecting_source"),
    /** O que o saneamento corrigiu na resposta do modelo — transparência para a auditoria. */
    corrections: z.array(z.string()),
  })
  .strict();
export type HunterResearch = z.infer<typeof hunterResearchSchema>;
