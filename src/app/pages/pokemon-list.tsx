import { raw } from "../../lib/query-compiler.ts";
import { SectionList } from "../../lib/section.tsx";
import { getSchema, execute } from "../data.ts";
import { getQueryRoot, getQueryMeta } from "../../framework/context.ts";

interface Props {
	sections?: string | null;
}

export function PokemonListPage({ sections }: Props) {
	return (
		<SectionList getSchema={getSchema} execute={execute} sections={sections}>
			<PokemonList key="list" />
			<QueryDebug key="debug" />
		</SectionList>
	);
}

function PokemonList() {
	const q = getQueryRoot();
	const pokemonList = q.pokemon_v2_pokemon({ limit: 12, order_by: raw("{id: asc}") });
	return (
		<div>
			<h1>Pokedex — Proxy Data Layer PoC</h1>
			<p style={{ color: "#888", marginBottom: "1.5rem" }}>
				Each card below was rendered by a component that just accesses{" "}
				<code style={{ background: "#2d3748", padding: "0.15rem 0.4rem", borderRadius: 4 }}>
					pokemon.name.value
				</code>{" "}
				— the query was generated automatically from those access patterns.
			</p>
			<div className="grid">
				{pokemonList.map((pokemon: any) => (
					<PokemonCard key={pokemon.id.value} pokemon={pokemon} />
				))}
			</div>
		</div>
	);
}

function PokemonCard({ pokemon }: { pokemon: any }) {
	const id = pokemon.id.value;
	const name = pokemon.name.value as string;
	const sprites = pokemon.pokemon_v2_pokemonsprites.map(
		(s: any) => s.sprites.value,
	);
	const types = pokemon.pokemon_v2_pokemontypes.map(
		(t: any) => t.pokemon_v2_type.name.value as string,
	);

	const spriteUrl =
		sprites[0]?.other?.["official-artwork"]?.front_default ??
		sprites[0]?.front_default ??
		null;

	return (
		<a href={`/pokemon/${id}`} className="card" style={{ display: "block" }}>
			{spriteUrl && (
				<img
					src={spriteUrl}
					alt={name}
					style={{ width: 96, height: 96, imageRendering: "auto" as const }}
				/>
			)}
			<h2 style={{ textTransform: "capitalize" as const }}>
				#{id} {name}
			</h2>
			<div style={{ marginTop: "0.5rem" }}>
				{(types as string[]).map((t) => (
					<span key={t} className={`badge badge-${t || "default"}`}>
						{t}
					</span>
				))}
			</div>
		</a>
	);
}

function QueryDebug() {
	const meta = getQueryMeta();
	return (
		<details className="query-debug">
			<summary style={{ cursor: "pointer", color: "#888", fontSize: "0.85rem" }}>
				Generated GraphQL Query
			</summary>
			<pre>{meta.query}</pre>
		</details>
	);
}
