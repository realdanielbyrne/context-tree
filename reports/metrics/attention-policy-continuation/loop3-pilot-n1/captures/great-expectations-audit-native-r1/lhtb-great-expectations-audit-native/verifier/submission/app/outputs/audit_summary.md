# Data Quality Audit Summary
## Overall
- Overall pass: **False**
- Expectation suites passing: 4/4
- Cross-table checks passed: 3/3
- Rows quarantined: 37

## Dataset Counts
- customers: 8 cleaned rows, 12/12 expectations passed
- orders: 6 cleaned rows, 13/13 expectations passed
- payments: 5 cleaned rows, 15/15 expectations passed
- refunds: 1 cleaned rows, 15/15 expectations passed

## Quarantine Reasons
- duplicate_primary_key: 2
- invalid_amount: 1
- invalid_amount;unknown_customer: 1
- invalid_amount;unknown_order: 2
- invalid_country: 1
- invalid_currency: 1
- invalid_date: 3
- invalid_date;unknown_order: 1
- invalid_email: 1
- invalid_method;unknown_order: 1
- invalid_primary_key;missing_customer_id: 1
- invalid_reason;unknown_order: 1
- invalid_status: 3
- invalid_status;unknown_customer: 1
- invalid_tier: 2
- missing_email: 1
- refund_exceeds_order_amount: 1
- unknown_customer: 3
- unknown_order: 10

## Reconciliation
- Total orders: 6
- Balanced orders: 4
- Unbalanced orders: 2
- Total order amount: 7731 cents
- Total settled payments: 10526 cents
- Total processed refunds: 100 cents
- Total net collected: 10426 cents

## Failed Expectations
- none
