export const MODEL = 'typesafe-ai/jev';
export const REVIEW_THRESHOLD = 0.85;
export const MAX_TRANSACTIONS = 25;
// Describes the business in the classifier prompt. Replace with your own.
export const BUSINESS_CONTEXT = 'an illustrative small business';
// ISO 4217 code used when a transaction does not specify a currency.
export const DEFAULT_CURRENCY = 'AUD';

// Illustrative accounts only: replace with the business's approved chart of accounts.
export const categories = [
  { id: 'sales_income', label: 'Sales income', description: 'Receipts explicitly described as payment from customers for goods or services. Deposits alone do not establish sales.' },
  { id: 'software_subscriptions', label: 'Software & subscriptions', description: 'Business software subscriptions, cloud hosting and online productivity tools.' },
  { id: 'advertising', label: 'Advertising', description: 'Paid advertising, marketing campaigns and promotional services.' },
  { id: 'office_supplies', label: 'Office supplies', description: 'Explicitly identified consumable office stationery and supplies. Unspecified retailer purchases and equipment need review.' },
  { id: 'rent', label: 'Rent', description: 'Explicit business premises rent or office lease payments.' },
  { id: 'utilities', label: 'Utilities & communications', description: 'Business electricity, gas, water, internet or phone service.' },
  { id: 'professional_fees', label: 'Professional fees', description: 'Accounting, bookkeeping, consulting and legal service fees.' },
  { id: 'travel_transport', label: 'Travel & transport', description: 'Clearly identified business transport or travel, including fares, parking and accommodation. Do not infer business purpose from a merchant alone.' },
  { id: 'meals_entertainment', label: 'Meals & entertainment', description: 'Clearly identified business meals or entertainment, without implying tax deductibility. Unexplained cafes and restaurants need review.' },
  { id: 'bank_fees', label: 'Bank fees', description: 'Explicit bank service fees, card processing fees or transaction charges. Not loan principal or interest.' },
  { id: 'transfers', label: 'Transfers', description: 'Explicit transfers between the business own bank accounts; not income or expenses. Unidentified transfers need review.' },
  { id: 'personal', label: 'Personal / owner', description: 'Transactions explicitly identified as personal, owner drawings or owner contributions. Do not infer from merchant alone.' },
  { id: 'unassigned', label: 'Unassigned', description: 'Insufficient context, ambiguous or mixed transactions, unspecified refunds, loans, taxes, asset purchases, or anything without an appropriate account above. Prefer this over guessing.' },
] as const;

export type Transaction = { description: string; amount: number; currency: string };

export const samples: Transaction[] = [
  { description: 'Figma monthly subscription for design team', amount: -24, currency: 'AUD' },
  { description: 'Customer payment for consulting invoice INV-1042', amount: 1650, currency: 'AUD' },
  { description: 'Bank monthly business account service fee', amount: -10, currency: 'AUD' },
  { description: 'Transfer to our business savings account', amount: -500, currency: 'AUD' },
  { description: 'Office stationery: printer paper and pens', amount: -48.5, currency: 'AUD' },
  { description: 'Monthly bookkeeping services', amount: -330, currency: 'AUD' },
  { description: 'PAYMENT 839102', amount: -87.2, currency: 'AUD' },
  { description: 'Amazon marketplace', amount: -124.95, currency: 'AUD' },
];
