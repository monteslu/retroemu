local pulse = 0

function love.load()
  love.graphics.setBackgroundColor(0.025, 0.04, 0.08)
end

function love.update(dt)
  pulse = pulse + dt
end

function love.draw()
  local glow = 0.5 + math.sin(pulse * 2) * 0.15
  love.graphics.setColor(0.1, glow, 0.8, 1)
  love.graphics.rectangle("fill", 0, 0, 180, 720)
  love.graphics.rectangle("fill", 1100, 0, 180, 720)
  love.graphics.setColor(1, 1, 1, 1)
  love.graphics.print("ACTIVE", 28, 36)
  love.graphics.print("BEZEL", 1130, 36)
end
