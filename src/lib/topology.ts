import type { MeshData, TopologyReport } from '../types'

class UnionFind {
  private parent: Int32Array
  constructor(size: number) {
    this.parent = Int32Array.from({ length: size }, (_, index) => index)
  }
  find(value: number): number {
    if (this.parent[value] !== value) this.parent[value] = this.find(this.parent[value]!)
    return this.parent[value]!
  }
  union(left: number, right: number) {
    const a = this.find(left)
    const b = this.find(right)
    if (a !== b) this.parent[b] = a
  }
}

function edgeKey(left: number, right: number): string {
  return left < right ? `${left}:${right}` : `${right}:${left}`
}

function triangleAreaSquared(positions: Float32Array, a: number, b: number, c: number): number {
  const ax = positions[a * 3] ?? 0
  const ay = positions[a * 3 + 1] ?? 0
  const az = positions[a * 3 + 2] ?? 0
  const abx = (positions[b * 3] ?? 0) - ax
  const aby = (positions[b * 3 + 1] ?? 0) - ay
  const abz = (positions[b * 3 + 2] ?? 0) - az
  const acx = (positions[c * 3] ?? 0) - ax
  const acy = (positions[c * 3 + 1] ?? 0) - ay
  const acz = (positions[c * 3 + 2] ?? 0) - az
  const crossX = aby * acz - abz * acy
  const crossY = abz * acx - abx * acz
  const crossZ = abx * acy - aby * acx
  return crossX * crossX + crossY * crossY + crossZ * crossZ
}

export function inspectTopology(mesh: MeshData): TopologyReport {
  const vertices = mesh.positions.length / 3
  const faces = mesh.indices.length / 3
  const edgeIncidence = new Map<string, { count: number; a: number; b: number; cornerA: number; cornerB: number }>()
  const used = new Set<number>()
  const unionFind = new UnionFind(vertices)
  // Each triangle corner belongs to one vertex's face fan. Join corners across
  // shared edges, so two shells touching only at a vertex keep separate fans.
  const vertexFans = new UnionFind(mesh.indices.length)
  const nonManifoldVertices = new Set<number>()
  let degenerateFaces = 0

  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    const triangle = [mesh.indices[offset]!, mesh.indices[offset + 1]!, mesh.indices[offset + 2]!]
    // Mesh positions are already Float32. Positive-area sliver triangles are
    // valid manifold facets and must not be confused with actually collapsed
    // faces when deciding whether STL export is safe.
    if (new Set(triangle).size < 3 || triangleAreaSquared(mesh.positions, triangle[0], triangle[1], triangle[2]) === 0) {
      degenerateFaces += 1
    }
    for (const vertex of triangle) used.add(vertex)
    for (let side = 0; side < 3; side += 1) {
      const nextSide = (side + 1) % 3
      const a = triangle[side]!
      const b = triangle[nextSide]!
      const cornerA = offset + (a < b ? side : nextSide)
      const cornerB = offset + (a < b ? nextSide : side)
      const key = edgeKey(a, b)
      const existing = edgeIncidence.get(key)
      if (existing) {
        existing.count += 1
        vertexFans.union(existing.cornerA, cornerA)
        vertexFans.union(existing.cornerB, cornerB)
        if (existing.count > 2) {
          nonManifoldVertices.add(a)
          nonManifoldVertices.add(b)
        }
      } else {
        edgeIncidence.set(key, { count: 1, a: Math.min(a, b), b: Math.max(a, b), cornerA, cornerB })
      }
      unionFind.union(a, b)
    }
  }

  const firstFan = new Int32Array(vertices).fill(-1)
  for (let corner = 0; corner < mesh.indices.length; corner += 1) {
    const vertex = mesh.indices[corner]!
    const fan = vertexFans.find(corner)
    if (firstFan[vertex] === -1) firstFan[vertex] = fan
    else if (firstFan[vertex] !== fan) nonManifoldVertices.add(vertex)
  }

  const boundary = [...edgeIncidence.values()].filter((edge) => edge.count === 1)
  const nonManifoldEdges = [...edgeIncidence.values()].filter((edge) => edge.count > 2).length
  const componentRoots = new Set([...used].map((vertex) => unionFind.find(vertex)))
  const boundaryAdjacency = new Map<number, Set<number>>()
  for (const edge of boundary) {
    if (!boundaryAdjacency.has(edge.a)) boundaryAdjacency.set(edge.a, new Set())
    if (!boundaryAdjacency.has(edge.b)) boundaryAdjacency.set(edge.b, new Set())
    boundaryAdjacency.get(edge.a)!.add(edge.b)
    boundaryAdjacency.get(edge.b)!.add(edge.a)
  }
  let boundaryLoops = 0
  const visited = new Set<number>()
  for (const start of boundaryAdjacency.keys()) {
    if (visited.has(start)) continue
    boundaryLoops += 1
    const stack = [start]
    while (stack.length) {
      const current = stack.pop()!
      if (visited.has(current)) continue
      visited.add(current)
      for (const next of boundaryAdjacency.get(current) ?? []) stack.push(next)
    }
  }

  return {
    vertices,
    edges: edgeIncidence.size,
    faces,
    boundaryEdges: boundary.length,
    boundaryLoops,
    connectedComponents: componentRoots.size,
    nonManifoldEdges,
    nonManifoldVertices: nonManifoldVertices.size,
    eulerCharacteristic: vertices - edgeIncidence.size + faces,
    watertight: boundary.length === 0
      && nonManifoldEdges === 0
      && nonManifoldVertices.size === 0
      && degenerateFaces === 0
      && componentRoots.size > 0,
    degenerateFaces,
  }
}
