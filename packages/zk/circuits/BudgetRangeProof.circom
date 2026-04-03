pragma circom 2.0.0;

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/comparators.circom";

template BudgetRangeProof() {
    // Public inputs
    signal input counter_price_scaled;
    signal input budget_commitment;

    // Private inputs
    signal input budget_hard_scaled;
    signal input commitment_salt;

    // Constraint 1: commitment integrity
    component poseidon = Poseidon(2);
    poseidon.inputs[0] <== budget_hard_scaled;
    poseidon.inputs[1] <== commitment_salt;
    poseidon.out === budget_commitment;

    // Constraint 2: range check — counter ≤ budget
    component leq = LessEqThan(64);
    leq.in[0] <== counter_price_scaled;
    leq.in[1] <== budget_hard_scaled;
    leq.out === 1;
}

component main {public [counter_price_scaled, budget_commitment]} = BudgetRangeProof();
