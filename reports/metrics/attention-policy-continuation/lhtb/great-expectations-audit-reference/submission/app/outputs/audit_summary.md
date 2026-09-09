# Data Quality Audit Summary
## Overall
dataset: public_audit
overall_pass: false
overall_balanced: false
## Dataset Counts
customers: input=16 output=9 quarantined=7
orders: input=18 output=9 quarantined=9
payments: input=13 output=8 quarantined=5
refunds: input=10 output=4 quarantined=6
## Quarantine Reasons
duplicate_primary_key: 4
invalid_amount: 4
invalid_country: 1
invalid_currency: 1
invalid_date: 4
invalid_email: 2
invalid_method: 1
invalid_primary_key: 1
invalid_reason: 1
invalid_status: 1
invalid_tier: 1
refund_exceeds_order_amount: 1
unknown_customer: 3
unknown_order: 2
## Reconciliation
orders_count: 9
balanced_orders: 8
unbalanced_orders: 1
order_amount_cents: 34279
settled_payment_cents: 28075
processed_refund_cents: 1100
net_collected_cents: 26975
## Failed Expectations
all_orders_reconciled
