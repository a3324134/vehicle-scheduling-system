"""Numbers given by the spec, plus the few we chose ourselves."""

DAY_SECONDS = 24 * 60 * 60

# Bonus 1.2 / 1.3
INITIAL_BATTERY = 80
MAX_BATTERY = 100
BATTERY_COST_PER_BLOCK = 1
LOW_BATTERY_THRESHOLD = 30
DEPARTURE_BATTERY_REQUIRED = 80
CHARGE_SECONDS_PER_UNIT = 12

# Our own rules: the spec gives no numbers for these
MIN_DWELL_SECONDS = 1
DEFAULT_TRAVERSAL_SECONDS = 60

# Bonus 3: how long generated services stop at each platform
GENERATED_DWELL_SECONDS = 10
