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
  const edgeIncidence = new Map<string, { count: number; a: number; b: number }>()
  const used = new Set<number>()
  const unionFind = new UnionFind(vertices)
  let degenerateFaces = 0

  for (let offset = 0; offset < mesh.indices.length; offset += 3) {
    const triangle = [mesh.indices[offset]!, mesh.indices[offset + 1]!, mesh.indices[offset + 2]!]
    if (new Set(triangle).size < 3 || triangleAreaSquared(mesh.positions, triangle[0], triangle[1], triangle[2]) < 1e-14) {
      degenerateFaces += 1
    }
    for (const vertex of triangle) used.add(vertex)
    for (const [a, b] of [[triangle[0], triangle[1]], [triangle[1], triangle[2]], [triangle[2], triangle[0]]] as const) {
      const key = edgeKey(a, b)
      const existing = edgeIncidence.get(key)
      if (existing) existing.count += 1
      else edgeIncidence.set(key, { count: 1, a: Math.min(a, b), b: Math.max(a, b) })
      unionFind.union(a, b)
    }
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
    eulerCharacteristic: vertices - edgeIncidence.size + faces,
    watertight: boundary.length === 0 && nonManifoldEdges === 0 && degenerateFaces === 0 && componentRoots.size > 0,
    degenerateFaces,
  }
}
