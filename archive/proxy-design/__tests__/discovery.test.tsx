import React from "react"
import { describe, expect, it } from "vitest"
import { AccessRecorder } from "../access-recorder.ts"
import { renderForDiscovery } from "../discovery.ts"
import { createProxy } from "../proxy-node.ts"
import { compileQuery } from "../query-compiler.ts"
import { SchemaGraph, type SchemaObjectType } from "../schema.ts"

function createTestSchema(): SchemaGraph {
  const types: SchemaObjectType[] = [
    {
      name: "Pokemon",
      fields: [
        {
          name: "id",
          type: {
            kind: "NON_NULL",
            name: null,
            ofType: { kind: "SCALAR", name: "Int", ofType: null },
          },
          args: [],
        },
        {
          name: "name",
          type: { kind: "SCALAR", name: "String", ofType: null },
          args: [],
        },
        {
          name: "height",
          type: { kind: "SCALAR", name: "Int", ofType: null },
          args: [],
        },
        {
          name: "sprites",
          type: { kind: "OBJECT", name: "Sprites", ofType: null },
          args: [],
        },
        {
          name: "types",
          type: {
            kind: "LIST",
            name: null,
            ofType: { kind: "OBJECT", name: "PokemonType", ofType: null },
          },
          args: [],
        },
        {
          name: "species",
          type: { kind: "OBJECT", name: "Species", ofType: null },
          args: [],
        },
      ],
    },
    {
      name: "Sprites",
      fields: [
        {
          name: "front_default",
          type: { kind: "SCALAR", name: "String", ofType: null },
          args: [],
        },
      ],
    },
    {
      name: "PokemonType",
      fields: [
        {
          name: "slot",
          type: { kind: "SCALAR", name: "Int", ofType: null },
          args: [],
        },
        {
          name: "type",
          type: { kind: "OBJECT", name: "Type", ofType: null },
          args: [],
        },
      ],
    },
    {
      name: "Type",
      fields: [
        {
          name: "name",
          type: { kind: "SCALAR", name: "String", ofType: null },
          args: [],
        },
      ],
    },
    {
      name: "Species",
      fields: [
        {
          name: "name",
          type: { kind: "SCALAR", name: "String", ofType: null },
          args: [],
        },
        {
          name: "generation",
          type: { kind: "OBJECT", name: "Generation", ofType: null },
          args: [],
        },
      ],
    },
    {
      name: "Generation",
      fields: [
        {
          name: "name",
          type: { kind: "SCALAR", name: "String", ofType: null },
          args: [],
        },
      ],
    },
  ]
  return new SchemaGraph(types)
}

describe("renderForDiscovery", () => {
  const schema = createTestSchema()

  it("discovers accesses from JSX components", () => {
    function Card({ pokemon }: { pokemon: any }) {
      return (
        <div>
          {pokemon.name.value} #{pokemon.id.value}
        </div>
      )
    }
    const recorder = new AccessRecorder()
    const phantom = createProxy(schema, "Pokemon", recorder)
    renderForDiscovery(<Card pokemon={phantom} />)
    const fields = recorder.getAccessTree().map((n) => n.field)
    expect(fields).toContain("name")
    expect(fields).toContain("id")
  })

  it("discovers through nested component tree", () => {
    function TypeBadge({ type }: { type: any }) {
      return <span>{type.type.name.value}</span>
    }
    function Card({ pokemon }: { pokemon: any }) {
      return (
        <div>
          <h1>{pokemon.name.value}</h1>
          {pokemon.types.map((t: any) => (
            <TypeBadge key={t.slot.value} type={t} />
          ))}
        </div>
      )
    }
    const recorder = new AccessRecorder()
    renderForDiscovery(<Card pokemon={createProxy(schema, "Pokemon", recorder)} />)
    const query = compileQuery(recorder.getAccessTree(), "pokemon")
    expect(query).toContain("name")
    expect(query).toContain("types")
    expect(query).toContain("slot")
    expect(query).toContain("type {")
  })

  it("discovers across sibling partials", () => {
    function Hero({ pokemon }: { pokemon: any }) {
      return <h1>{pokemon.name.value}</h1>
    }
    function Sprite({ pokemon }: { pokemon: any }) {
      return <img src={pokemon.sprites.front_default.value} />
    }
    function Species({ pokemon }: { pokemon: any }) {
      return <p>{pokemon.species.generation.name.value}</p>
    }
    function Page({ pokemon }: { pokemon: any }) {
      return (
        <div>
          <Hero pokemon={pokemon} />
          <Sprite pokemon={pokemon} />
          <Species pokemon={pokemon} />
        </div>
      )
    }
    const recorder = new AccessRecorder()
    renderForDiscovery(<Page pokemon={createProxy(schema, "Pokemon", recorder)} />)
    const query = compileQuery(recorder.getAccessTree(), "pokemon")
    expect(query).toContain("name")
    expect(query).toContain("sprites {")
    expect(query).toContain("species {")
    expect(query).toContain("generation {")
  })

  it("returns void", () => {
    function Card({ pokemon }: { pokemon: any }) {
      return <div>{pokemon.name.value}</div>
    }
    const recorder = new AccessRecorder()
    expect(
      renderForDiscovery(<Card pokemon={createProxy(schema, "Pokemon", recorder)} />),
    ).toBeUndefined()
  })

  it("full controller pattern", () => {
    function Card({ pokemon }: { pokemon: any }) {
      return (
        <div>
          #{pokemon.id.value} {pokemon.name.value} <img src={pokemon.sprites.front_default.value} />
        </div>
      )
    }
    function Page({ pokemonList }: { pokemonList: any }) {
      return (
        <div>
          {pokemonList.map((p: any) => (
            <Card key={p.id.value} pokemon={p} />
          ))}
        </div>
      )
    }

    const recorder = new AccessRecorder()
    renderForDiscovery(<Page pokemonList={createProxy(schema, "Pokemon", recorder)} />)
    const query = compileQuery(recorder.getAccessTree(), "pokemon")
    expect(query).toContain("id")
    expect(query).toContain("name")
    expect(query).toContain("sprites {")

    const dataProxy = createProxy(schema, "Pokemon", new AccessRecorder(), {
      id: 25,
      name: "pikachu",
      sprites: { front_default: "https://example.com/pikachu.png" },
    })
    const jsx = JSON.stringify(Card({ pokemon: dataProxy }))
    expect(jsx).toContain("pikachu")
    expect(jsx).not.toContain("__mock")
  })

  it("handles components that throw", () => {
    function Broken({ pokemon }: { pokemon: any }) {
      pokemon.name.value
      throw new Error("boom")
    }
    const recorder = new AccessRecorder()
    renderForDiscovery(<Broken pokemon={createProxy(schema, "Pokemon", recorder)} />)
    expect(recorder.getAccessTree().map((n) => n.field)).toContain("name")
  })

  it("discovers through throwing wrapper (client component pattern)", () => {
    // Simulates a client component with hooks that throws during discovery
    function ClientWrapper({ children }: { children: React.ReactNode }) {
      throw new Error("hooks not available")
      return <div>{children}</div>
    }
    function Card({ pokemon }: { pokemon: any }) {
      return (
        <div>
          {pokemon.name.value} - {pokemon.height.value}
        </div>
      )
    }

    const recorder = new AccessRecorder()
    const phantom = createProxy(schema, "Pokemon", recorder)

    // ClientWrapper throws, but discovery should still walk its children
    renderForDiscovery(
      <ClientWrapper>
        <Card pokemon={phantom} />
      </ClientWrapper>,
    )

    const fields = recorder.getAccessTree().map((n) => n.field)
    expect(fields).toContain("name")
    expect(fields).toContain("height")
  })
})
