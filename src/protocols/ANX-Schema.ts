/**
 * ANX (Agent-Native XML) Schema Definition
 * Protocol for Standard Operating Procedures (SOPs)
 */

export interface MissionManifest {
  objective: string;
  scope: string[];
  constraints: string[];
  priority: 'low' | 'medium' | 'high' | 'critical';
}

export interface Provenance {
  creator: string;
  timestamp: string;
  version: string;
  lineage: string[]; // History of previous SOPs or agents involved
}

export interface SuccessCriteria {
  metrics: string[];
  validation_method: string;
  thresholds: Record<string, number | string>;
}

export interface AdversarialCritique {
  failure_modes: string[];
  mitigations: string[];
  red_team_notes: string;
}

export interface ANX_SOP {
  mission_manifest: MissionManifest;
  provenance: Provenance;
  success_criteria: SuccessCriteria;
  adversarial_critique: AdversarialCritique;
}

/**
 * Helper to generate a blank ANX XML template for SOPs
 */
export const generateANXTemplate = (): string => {
  return `
<sop_container>
  <mission_manifest>
    <objective><!-- High-level goal --></objective>
    <scope>
      <!-- <item>Range of action</item> -->
    </scope>
    <constraints>
      <!-- <item>Hard boundaries</item> -->
    </constraints>
    <priority>medium</priority>
  </mission_manifest>

  <provenance>
    <creator><!-- Agent ID or System Name --></creator>
    <timestamp>${new Date().toISOString()}</timestamp>
    <version>1.0.0</version>
    <lineage>
      <!-- <source>Parent SOP ID</source> -->
    </lineage>
  </provenance>

  <success_criteria>
    <metrics>
      <!-- <metric>KPI</metric> -->
    </metrics>
    <validation_method><!-- How to verify success --></validation_method>
    <thresholds>
      <!-- <threshold name="accuracy">0.95</threshold> -->
    </thresholds>
  </success_criteria>

  <adversarial_critique>
    <failure_modes>
      <!-- <mode>Potential risk</mode> -->
    </failure_modes>
    <mitigations>
      <!-- <plan>Response to failure</plan> -->
    </mitigations>
    <red_team_notes><!-- Critical analysis from adversarial perspective --></red_team_notes>
  </adversarial_critique>
</sop_container>
`.trim();
};

export default {
  generateANXTemplate
};
