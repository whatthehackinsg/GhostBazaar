#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ZK_DIR="$(dirname "$SCRIPT_DIR")"
ROOT_DIR="$(dirname "$(dirname "$ZK_DIR")")"
BUILD_DIR="$ZK_DIR/build"
KEYS_DIR="$ZK_DIR/keys"

# Resolve circomlib include path (pnpm hoists into .pnpm)
CIRCOMLIB_DIR="$(find "$ROOT_DIR/node_modules" -path "*/circomlib/circuits" -type d | head -1)"
if [ -z "$CIRCOMLIB_DIR" ]; then
  echo "Error: circomlib not found. Run 'pnpm install' first."
  exit 1
fi
# CIRCOMLIB_DIR = .../circomlib/circuits, go up twice to get the node_modules dir containing circomlib/
CIRCOMLIB_INCLUDE="$(dirname "$(dirname "$CIRCOMLIB_DIR")")"

mkdir -p "$BUILD_DIR" "$KEYS_DIR"

# Download Powers of Tau if not present
PTAU="$BUILD_DIR/pot12.ptau"
if [ ! -f "$PTAU" ]; then
  echo "Downloading Powers of Tau..."
  curl -L -o "$PTAU" https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_12.ptau
fi

# Compile circuit
echo "Compiling circuit..."
circom "$ZK_DIR/circuits/BudgetRangeProof.circom" \
  --r1cs --wasm --sym \
  -l "$CIRCOMLIB_INCLUDE" \
  --output "$BUILD_DIR/"

# Generate zkey
echo "Generating zkey..."
npx snarkjs groth16 setup \
  "$BUILD_DIR/BudgetRangeProof.r1cs" \
  "$PTAU" \
  "$BUILD_DIR/BudgetRangeProof_0.zkey"

# Contribute randomness
echo "Contributing randomness..."
npx snarkjs zkey contribute \
  "$BUILD_DIR/BudgetRangeProof_0.zkey" \
  "$BUILD_DIR/BudgetRangeProof_final.zkey" \
  --name="Ghost Bazaar hackathon" -v -e="ghost-bazaar-hackathon-entropy"

# Export verification key
echo "Exporting vkey..."
npx snarkjs zkey export verificationkey \
  "$BUILD_DIR/BudgetRangeProof_final.zkey" \
  "$KEYS_DIR/vkey.json"

echo "Setup complete!"
