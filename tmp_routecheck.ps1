$lines = Get-Content src/api/routes/cards.ts; for ($i=420; $i -lt 520; $i++) { "$($i+1): $($lines[$i])" }
