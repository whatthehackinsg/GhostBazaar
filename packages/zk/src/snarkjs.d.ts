declare module "snarkjs" {
  export const groth16: {
    fullProve(
      input: Record<string, string>,
      wasmFile: string,
      zkeyFile: string
    ): Promise<{ proof: any; publicSignals: string[] }>
    verify(
      vkey: any,
      publicSignals: string[],
      proof: any
    ): Promise<boolean>
  }
}
