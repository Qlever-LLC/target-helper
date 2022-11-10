/**
 * @license
 * Copyright 2022 Qlever LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
export function fromOadaType(type: string) {
  const vals = Object.values(conversions);

  return vals.find((v) => v.urlName === type);
}

const conversions = {
  'Unidentified': {
    name: 'Unidentified',
    urlName: 'unidentified',
    type: 'application/vnd.trellisfw.unidentified',
  },
  'ACH Form': {
    name: 'ACH Form',
    urlName: 'ach-forms',
    type: 'application/vnd.trellisfw.ach-form.1+json',
  },
  'Certificate of Insurance': {
    name: 'Certificate of Insurance',
    urlName: 'cois',
    type: 'application/vnd.trellisfw.coi.accord.1+json',
  },
  'Pure Food Guaranty and Indemnification Agreement (LOG)': {
    name: 'Pure Food Guaranty and Indemnification Agreement (LOG)',
    urlName: 'pfgias',
    type: 'application/vnd.trellisfw.pfgia.1+json',
  },
  'Letter of Guarantee': {
    name: 'Letter of Guarantee',
    urlName: 'letters-of-guarantee',
    type: 'application/vnd.trellisfw.letter-of-guarantee.1+json',
    alternativeNames: [
      'Pure Food Guaranty and Indemnification Agreement (LOG)',
    ],
  },
  'Emergency Contact Information': {
    name: 'Emergency Contact Information',
    urlName: 'emergency-contact-information',
    type: 'application/vnd.trellisfw.emergency-contact-information.1+json',
  },
  'Specifications that indicate acceptable requirements': {
    name: 'Specifications that indicate acceptable requirements',
    urlName: 'sars',
    type: 'application.vnd.trellisfw.sars.1+json',
  },
  'W-9': {
    name: 'W-9',
    urlName: 'w-9s',
    type: 'application/vnd.trellisfw.w-9.1+json',
  },
  '100g Nutritional Information': {
    name: '100g Nutritional Information',
    urlName: '100g-nutritional-information',
    type: 'application/vnd.trellisfw.nutritional-information.1+json',
    alternativeNames: ['Nutrition Information'],
  },
  'Allergen Statement': {
    name: 'Allergen Statement',
    urlName: 'allergen-statements',
    type: 'application/vnd.trellisfw.allergen-statement.1+json',
    alternativeNames: ['Ingredient Allergen Statement'],
  },
  'Bioengineered (BE) Ingredient Statement': {
    name: 'Bioengineered (BE) Ingredient Statement',
    urlName: 'be-ingredient-statements',
    type: 'application/vnd.trellisfw.be-ingredient-statement.1+json',
  },
  'California Prop 65 Statement': {
    name: 'California Prop 65 Statement',
    urlName: 'ca-prop-65-statements',
    type: 'application/vnd.trellisfw.ca-prop-65-statement.1+json',
  },
  'Country of Origin Statement': {
    name: 'Country of Origin Statement',
    urlName: 'coo-statements',
    type: 'application/vnd.trellisfw.coo-statement.1+json',
  },
  'Gluten Statement': {
    name: 'Gluten Statement',
    urlName: 'gluten-statements',
    type: 'application/vnd.trellisfw.gluten-statement.1+json',
    alternativeNames: ['Gluten Claim'],
  },
  'Ingredient Breakdown Range %': {
    name: 'Ingredient Breakdown Range %',
    urlName: 'ingredient-breakdowns',
    type: 'application/vnd.trellisfw.ingredient-breakdown.1+json',
    alternativeNames: ['% Product Composition'],
  },
  'Product Label': {
    name: 'Product Label',
    urlName: 'product-labels',
    type: 'application/vnd.trellisfw.product-label.1+json',
  },
  'Product Specification': {
    name: 'Product Specification',
    urlName: 'product-specs',
    type: 'application/vnd.trellisfw.product-spec.1+json',
    alternativeNames: ['Specification'],
  },
  'Safety Data Sheet (SDS)': {
    name: 'Safety Data Sheet (SDS)',
    urlName: 'sds',
    type: 'application/vnd.trellisfw.sds.1+json',
  },
  'GMO Statement': {
    name: 'GMO Statement',
    urlName: 'gmo-statements',
    type: 'application/vnd.trellisfw.gmo-statement.1+json',
  },
  'Natural Statement': {
    name: 'Natural Statement',
    urlName: 'natural-statements',
    type: 'application/vnd.trellisfw.natural-statement.1+json',
  },
  'GFSI Certificate': {
    name: 'GFSI Certificate',
    urlName: 'fsqa-certificates',
    type: 'application/vnd.trellisfw.fsqa-certificates.1+json',
  },
  'Non-Ambulatory (3D/4D) Animal Statement': {
    name: 'Non-Ambulatory (3D/4D) Animal Statement',
    urlName: 'animal-statements',
    type: 'application/vnd.trellisfw.animal-statement.1+json',
  },
  'Specified Risk Materials (SRM) Audit': {
    name: 'Specified Risk Materials (SRM) Audit',
    urlName: 'srm-audits',
    type: 'application/vnd.trellisfw.srm-audit.1+json',
  },
  'Specified Risk Materials (SRM) Statement': {
    name: 'Specified Risk Materials (SRM) Statement',
    urlName: 'srm-statements',
    type: 'application/vnd.trellisfw.srm-statement.1+json',
  },
  'Specified Risk Materials (SRM) Corrective Actions': {
    name: 'Specified Risk Materials (SRM) Corrective Actions',
    urlName: 'srm-corrective-actions',
    type: 'application/vnd.trellisfw.srm-corrective-actions.1+json',
  },
  'E.Coli 0157:H7 Intervention Audit': {
    name: 'E.Coli 0157:H7 Intervention Audit',
    urlName: 'ecoli-audits',
    type: 'application/vnd.trellisfw.ecoli-audit.1+json',
  },
  'Foreign Material Control Plan': {
    name: 'Foreign Material Control Plan',
    urlName: 'foreign-material-control-plans',
    type: 'application/vnd.trellisfw.foreign-material-control-plans.1+json',
  },
  'Animal Welfare Audit': {
    name: 'Animal Welfare Audit',
    urlName: 'animal-welfare-audits',
    type: 'application/vnd.trellisfw.animal-welfare-audit.1+json',
  },
  'Humane Harvest Statement': {
    name: 'Humane Harvest Statement',
    urlName: 'humane-harvest-statements',
    type: 'application/vnd.trellisfw.humane-harvest-statement.1+json',
    alternativeNames: ['Humane Slaughter Statement'],
  },
  'National Residue Program (NRP) Statement': {
    name: 'National Residue Program (NRP) Statement',
    urlName: 'nrp-statements',
    type: 'application/vnd.trellisfw.nrp-statement.1+json',
  },
  'Lot Code Explanation': {
    name: 'Lot Code Explanation',
    urlName: 'lot-code-explanations',
    type: 'application/vnd.trellisfw.lot-code-explanation.1+json',
  },
  'APHIS Statement': {
    name: 'APHIS Statement',
    urlName: 'aphis-statements',
    type: 'application/vnd.trellisfw.aphis-statement.1+json',
  },
  'Bisphenol A (BPA) Statement': {
    name: 'Bisphenol A (BPA) Statement',
    urlName: 'bpa-statements',
    type: 'application/vnd.trellisfw.bpa-statement.1+json',
  },
  'GFSI Audit': {
    name: 'GFSI Audit',
    urlName: 'fsqa-audits',
    type: 'application/vnd.trellisfw.fsqa-audit.1+json',
  },
  'HACCP Plan / Flow Chart': {
    name: 'HACCP Plan / Flow Chart',
    urlName: 'haccp-plans',
    type: 'application/vnd.trellisfw.haccp-plan.1+json',
  },
  'Co-Packer FSQA Questionnaire (GFSI Certified)': {
    name: 'Co-Packer FSQA Questionnaire (GFSI Certified)',
    urlName: 'copacker-fsqa-questionnaires',
    type: 'application/vnd.trellisfw.copacker-fsqa-questionnaire.1+json',
  },
  'Co-Pack Confidentiality Agreement Form': {
    name: 'Co-Pack Confidentiality Agreement Form',
    urlName: 'copack-confidentiality-agreement-forms',
    type: 'application/vnd.trellisfw.copack-confidentiality-agreement-form.1+json',
  },
  'Third Party Food Safety GMP Audit Corrective Actions': {
    name: 'Third Party Food Safety GMP Audit Corrective Actions',
    urlName: 'tpa-corrective-actions',
    type: 'application/vnd.trellisfw.tpa-corrective-actions.1+json',
  },
  'W-8': {
    name: 'W-8',
    urlName: 'w-8s',
    type: 'application/vnd.trellisfw.w-8.1+json',
  },
  'Third Party Food Safety GMP Audit': {
    name: 'Third Party Food Safety GMP Audit',
    urlName: 'fsqa-audits',
    type: 'application/vnd.trellisfw.fsqa-audit.1+json',
  },
  'Animal Welfare Corrective Actions': {
    name: 'Animal Welfare Corrective Actions',
    urlName: 'animal-welfare-corrective-actions',
    type: 'application/vnd.trellisfw.animal-welfare-corrective-actions.1+json',
  },
  'Third Party Food Safety GMP Certificate': {
    name: 'Third Party Food Safety GMP Certificate',
    urlName: 'fsqa-certificates',
    type: 'application/vnd.trellisfw.fsqa-certificate.1+json',
  },
  'Small Business Administration (SBA) Form': {
    name: 'Small Business Administration (SBA) Form',
    urlName: 'sba-forms',
    type: 'application/vnd.trellisfw.sba-form.1+json',
  },
  'WIRE Form': {
    name: 'WIRE Form',
    urlName: 'wire-forms',
    type: 'application/vnd.trellisfw.wire-form.1+json',
  },
  'E.Coli 0157:H7 Intervention Statement': {
    name: 'E.Coli 0157:H7 Intervention Statement',
    urlName: 'ecoli-statements',
    type: 'application/vnd.trellisfw.ecoli-statement.1+json',
  },
  'Business License': {
    name: 'Business License',
    urlName: 'business-licenses',
    type: 'application/vnd.trellisfw.business-license.1+json',
  },
  'Rate Sheet': {
    name: 'Rate Sheet',
    urlName: 'rate-sheets',
    type: 'application/vnd.trellisfw.rate-sheet.1+json',
  },
  'Master Service Agreement (MSA)': {
    name: 'Master Service Agreement (MSA)',
    urlName: 'msas',
    type: 'application/vnd.trellisfw.msa.1+json',
  },
};

export function fromName(name: keyof typeof conversions) {
  return conversions[name];
}
