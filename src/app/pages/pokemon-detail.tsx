import { raw } from "../../lib/query-compiler.ts";
import { SectionList } from "../../lib/section.tsx";
import { SectionControls } from "../components/section-controls.tsx";
import { getSchema, execute } from "../data.ts";
import { getQueryRoot, getQueryMeta } from "../../framework/context.ts";

interface Props {
  pokemonId: number;
  sections?: string | null;
}

export function PokemonDetailPage({ pokemonId, sections }: Props) {
  return (
    <>
      <SectionControls />
      <SectionList getSchema={getSchema} execute={execute} sections={sections}>
        <HeroSection key="hero" pokemonId={pokemonId} />
        <StatsSection key="stats" pokemonId={pokemonId} />
        <SpeciesSection key="species" pokemonId={pokemonId} />
        <QueryDebug key="debug" />
      </SectionList>
    </>
  );
}

function HeroSection({ pokemonId }: { pokemonId: number }) {
  const q = getQueryRoot();
  const pokemon = q.pokemon_v2_pokemon({ where: raw(`{id: {_eq: ${pokemonId}}}`), limit: 1 })[0];
  const id = pokemon.id.value;
  const name = pokemon.name.value as string;
  const height = pokemon.height.value as number;
  const weight = pokemon.weight.value as number;
  const sprites = pokemon.pokemon_v2_pokemonsprites.map((s: any) => s.sprites.value);
  const types = pokemon.pokemon_v2_pokemontypes.map((t: any) => ({
    slot: t.slot.value as number,
    name: t.pokemon_v2_type.name.value as string,
  }));

  const spriteUrl =
    sprites[0]?.other?.["official-artwork"]?.front_default ??
    sprites[0]?.front_default;

  return (
    <div className="card" style={{ display: "flex", gap: "2rem", alignItems: "center" }}>
      {spriteUrl && (
        <img src={spriteUrl} alt={name} style={{ width: 200, height: 200 }} />
      )}
      <div>
        <h1 style={{ textTransform: "capitalize" as const, fontSize: "2rem" }}>
          #{id} {name}
        </h1>
        <div style={{ marginTop: "0.75rem" }}>
          {types.map((t: { slot: number; name: string }) => (
            <span key={t.slot} className={`badge badge-${t.name || "default"}`}>
              {t.name}
            </span>
          ))}
        </div>
        <div className="meta" style={{ marginTop: "1rem" }}>
          Height: {height / 10}m · Weight: {weight / 10}kg
        </div>
      </div>
    </div>
  );
}

function StatsSection({ pokemonId }: { pokemonId: number }) {
  const q = getQueryRoot();
  const pokemon = q.pokemon_v2_pokemon({ where: raw(`{id: {_eq: ${pokemonId}}}`), limit: 1 })[0];
  const stats = pokemon.pokemon_v2_pokemonstats.map((s: any) => ({
    name: s.pokemon_v2_stat.name.value as string,
    value: s.base_stat.value as number,
  }));

  const maxStat = 255;

  return (
    <div className="card">
      <h2>Base Stats</h2>
      <div style={{ marginTop: "0.75rem" }}>
        {(stats as Array<{ name: string; value: number }>).map((stat) => (
          <div key={stat.name} style={{ display: "flex", alignItems: "center", marginBottom: "0.5rem", gap: "0.75rem" }}>
            <span style={{ width: 120, fontSize: "0.85rem", textTransform: "capitalize" as const, color: "#aaa" }}>
              {stat.name.replace("-", " ")}
            </span>
            <span style={{ width: 35, fontSize: "0.85rem", textAlign: "right" as const }}>
              {stat.value}
            </span>
            <div style={{ flex: 1, height: 8, background: "#2d3748", borderRadius: 4, overflow: "hidden" as const }}>
              <div style={{
                width: `${(stat.value / maxStat) * 100}%`,
                height: "100%",
                background: stat.value >= 100 ? "#48bb78" : stat.value >= 60 ? "#ecc94b" : "#f56565",
                borderRadius: 4,
              }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SpeciesSection({ pokemonId }: { pokemonId: number }) {
  const q = getQueryRoot();
  const pokemon = q.pokemon_v2_pokemon({ where: raw(`{id: {_eq: ${pokemonId}}}`), limit: 1 })[0];
  const species = pokemon.pokemon_v2_pokemonspecy;
  const speciesName = species.name.value as string;
  const happiness = species.base_happiness.value;
  const captureRate = species.capture_rate.value;
  const generation = species.pokemon_v2_generation.name.value;
  const flavorTexts = species.pokemon_v2_pokemonspeciesflavortexts.map(
    (ft: any) => ({
      text: ft.flavor_text.value as string,
      language: ft.pokemon_v2_language.name.value as string,
    }),
  );

  const englishEntry = (
    flavorTexts as Array<{ text: string; language: string }>
  ).find((ft) => ft.language === "en");

  return (
    <div className="card">
      <h2 style={{ textTransform: "capitalize" as const }}>
        Species: {speciesName}
      </h2>
      {englishEntry && (
        <p style={{ marginTop: "0.75rem", lineHeight: 1.6, color: "#ccc" }}>
          {englishEntry.text.replace(/\f|\n/g, " ")}
        </p>
      )}
      <div className="meta" style={{ marginTop: "1rem" }}>
        Generation: <code>{generation}</code> · Base Happiness:{" "}
        <code>{happiness}</code> · Capture Rate: <code>{captureRate}</code>
      </div>
    </div>
  );
}

function QueryDebug() {
  const meta = getQueryMeta();
  return (
    <details className="query-debug">
      <summary style={{ cursor: "pointer", color: "#888", fontSize: "0.85rem" }}>
        Generated GraphQL Query (auto-compiled from proxy access patterns)
      </summary>
      <pre>{meta.query}</pre>
    </details>
  );
}
