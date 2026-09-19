--[[
Wabbajack - the safehouse panel, for people who live in more than one.

THE BUG THIS EXISTS FOR
User Panel -> Safehouse does not open *a* safehouse of your choosing, it opens
one particular safehouse, and there is no way to ask it for a different one:

    ISUserPanelUI.lua:141
        ISSafehouseUI:new(..., SafeHouse.hasSafehouse(self.player), self.player)

SafeHouse.hasSafehouse walks safehouseList front to back and returns the FIRST
entry whose player list contains the name, or whose owner is the name -
disassembled out of zombie/iso/areas/SafeHouse in projectzomboid.jar on
2026-08-19 (B42.20), where the loop is plainly `getPlayers().contains(name) ||
getOwner().equals(name)` and returns on the first hit.

That list is in claim order, so "first" means oldest. A player who belongs to
two safehouses can only ever open the older one, and the Quit button on that
panel quits that one. The newer membership is unreachable, and therefore
permanent.

There is no second door. ISWorldObjectContextMenu still defines
onViewSafeHouse (line 526) but nothing in B42.20 puts it on a menu -
ContextMenu_ViewSafehouse is in the translations and in no .lua file - so
besides the User Panel the only way into ISSafehouseUI is the admin panel's
safehouse list, which ordinary players cannot open.

It presents as "Quit does nothing", and it is worse when the oldest hit is a
house you OWN: ISSafehouseUI hides Quit entirely for the owner (line 272,
`not isOwner and ...`), so the button the player is hunting for is not on the
screen at all. That is Jerkmate's case - he owns "The HorseShoe" (claimed
2026-08-13) and is a member of MrthurAorgan's "Bobs World" (2026-08-15), so his
panel is always The HorseShoe and Bobs World has no door.

WHAT THIS DOES
Wraps ISUserPanelUI:onOptionMouseDown. When the player belongs to more than one
safehouse, the button opens a picker listing all of them; choosing one opens the
ordinary vanilla ISSafehouseUI for THAT safehouse, which is exactly what the
admin panel's View button already does with an arbitrary claim. Everybody with
one safehouse - which is nearly everybody - falls straight through to vanilla,
byte for byte unchanged.

NOT A PERMISSION CHANGE
The panel this opens is the stock one and it makes its own decisions: Quit still
requires that you are not the owner and are in the player list, Remove and
Release still require ownership or CanSetupSafehouses. All this fixes is which
safehouse the panel is pointed at. Quitting is handled server-side by
SafehouseChangeMemberPacket -> SafeHouse.kickUserFromSafehouse, which refuses to
remove an owner and is not otherwise gated, so nothing here needs the server to
agree to it.

Reading the list client-side is likewise how vanilla does it: every safehouse
check in this game runs on the client, which WabbajackRaidGate leans on too.

WHY A PLAYER IS IN TWO AT ALL
Vanilla means to prevent it and only half does. ISSafehouseUI.ReceiveSafehouseInvite
drops the invite dialog on the floor when SafeHouse.hasSafehouse(getPlayer()) is
non-nil, so an invite to a second safehouse normally never appears - but that is
one client-side check on one path, and memberships predating it, admin edits and
ownership transfers all land behind it. This file does not try to stop it from
happening; it makes it recoverable, which is the part players were stuck on.
]]

require "ISUI/ISPanel"
require "ISUI/UserPanel/ISUserPanelUI"
require "ISUI/UserPanel/ISSafehouseUI"

local FONT_HGT_SMALL = getTextManager():getFontHeight(UIFont.Small)
local FONT_HGT_MEDIUM = getTextManager():getFontHeight(UIFont.Medium)
local UI_BORDER_SPACING = 10
local BUTTON_HGT = FONT_HGT_SMALL + 6

local function log(msg) print("[WabbajackSafehousePicker] " .. tostring(msg)) end

--[[
Every safehouse this player belongs to, in the game's own list order.

Owner-or-member, matching what hasSafehouse tests, so the picker can never show
fewer entries than the button would have found. Everything is pcall'd: the
safehouse list arrives over the wire and a nil in it must not take the User
Panel down with it - an empty result here just means the vanilla path runs.
]]
local function safehousesOf(player)
    local out = {}
    if not player or not SafeHouse then return out end

    local ok, username = pcall(function() return player:getUsername() end)
    if not ok or not username then return out end

    local gotList, list = pcall(function() return SafeHouse.getSafehouseList() end)
    if not gotList or not list then return out end

    for i = 0, list:size() - 1 do
        local read, sh = pcall(function() return list:get(i) end)
        if read and sh then
            local asked, mine = pcall(function()
                if sh:getOwner() == username then return true end
                local players = sh:getPlayers()
                return players ~= nil and players:contains(username)
            end)
            if asked and mine then table.insert(out, sh) end
        end
    end
    return out
end

WabbajackSafehousePicker = ISPanel:derive("WabbajackSafehousePicker")

function WabbajackSafehousePicker:new(player)
    local width = 420 + getCore():getOptionFontSizeReal() * 20
    local height = FONT_HGT_MEDIUM + BUTTON_HGT * 9 + UI_BORDER_SPACING * 4
    local o = ISPanel:new(
        (getCore():getScreenWidth() - width) / 2,
        (getCore():getScreenHeight() - height) / 2,
        width, height)
    setmetatable(o, self)
    self.__index = self

    o.borderColor = { r = 0.4, g = 0.4, b = 0.4, a = 1 }
    o.backgroundColor = { r = 0, g = 0, b = 0, a = 0.8 }
    o.width = width
    o.height = height
    o.player = player
    o.moveWithMouse = true
    WabbajackSafehousePicker.instance = o
    return o
end

function WabbajackSafehousePicker:initialise()
    ISPanel.initialise(self)
    local btnWid = 100

    self.closeBtn = ISButton:new(UI_BORDER_SPACING + 1,
        self.height - UI_BORDER_SPACING - BUTTON_HGT - 1,
        btnWid, BUTTON_HGT, getText("IGUI_CraftUI_Close"), self,
        WabbajackSafehousePicker.onClick)
    self.closeBtn.internal = "CLOSE"
    self.closeBtn.anchorTop = false
    self.closeBtn.anchorBottom = true
    self.closeBtn:initialise()
    self.closeBtn:instantiate()
    self.closeBtn:enableCancelColor()
    self:addChild(self.closeBtn)

    self.viewBtn = ISButton:new(self.width - btnWid - UI_BORDER_SPACING - 1,
        self.closeBtn.y, btnWid, BUTTON_HGT, getText("IGUI_PlayerStats_View"),
        self, WabbajackSafehousePicker.onClick)
    self.viewBtn.internal = "VIEW"
    self.viewBtn.anchorTop = false
    self.viewBtn.anchorBottom = true
    self.viewBtn:initialise()
    self.viewBtn:instantiate()
    self.viewBtn.borderColor = { r = 1, g = 1, b = 1, a = 0.1 }
    self:addChild(self.viewBtn)

    local listY = UI_BORDER_SPACING * 2 + FONT_HGT_MEDIUM + 1
    self.list = ISScrollingListBox:new(UI_BORDER_SPACING + 1, listY,
        self.width - (UI_BORDER_SPACING + 1) * 2,
        self.height - UI_BORDER_SPACING * 2 - BUTTON_HGT - listY - 1)
    self.list:initialise()
    self.list:instantiate()
    self.list.itemheight = BUTTON_HGT
    self.list.selected = 1
    self.list.joypadParent = self
    self.list.font = UIFont.NewSmall
    self.list.doDrawItem = self.drawSafehouse
    self.list.drawBorder = true
    self.list.target = self
    self.list.onmousedblclick = WabbajackSafehousePicker.onDoubleClick
    self:addChild(self.list)

    self:populateList()
end

function WabbajackSafehousePicker:populateList()
    local selected = self.list.selected
    self.list:clear()
    for _, sh in ipairs(safehousesOf(self.player)) do
        self.list:addItem(sh:getTitle(), sh)
    end
    -- Keep the highlight where the player put it across a refresh, but never
    -- past the end of a list that just got shorter because they quit one.
    self.list.selected = math.min(math.max(selected, 1), #self.list.items)
end

--[[
The selected safehouse, read off the list rather than stashed during the draw.

ISSafehousesList captures its selection inside doDrawItem, which means the
buttons act on whatever was last painted - fine there, wrong the moment the list
is repopulated while a row is selected. Reading items[selected] on demand cannot
drift.
]]
function WabbajackSafehousePicker:selected()
    local row = self.list.items[self.list.selected]
    return row and row.item or nil
end

function WabbajackSafehousePicker:drawSafehouse(y, item, alt)
    local a = 0.9
    self:drawRectBorder(0, y, self:getWidth(), self.itemheight - 1, a,
        self.borderColor.r, self.borderColor.g, self.borderColor.b)
    if self.selected == item.index then
        self:drawRect(0, y, self:getWidth(), self.itemheight - 1, 0.3, 0.7, 0.35, 0.15)
    end

    local sh = item.item
    local owner = sh:getOwner()
    local username = self.parent.player:getUsername()
    local label = sh:getTitle() .. "  -  " ..
        (owner == username and "yours" or ("owned by " .. tostring(owner)))

    self:drawText(label, 10, y + 2, 1, 1, 1, a, self.font)
    return y + self.itemheight
end

function WabbajackSafehousePicker:prerender()
    self:drawRect(0, 0, self.width, self.height, self.backgroundColor.a,
        self.backgroundColor.r, self.backgroundColor.g, self.backgroundColor.b)
    self:drawRectBorder(0, 0, self.width, self.height, self.borderColor.a,
        self.borderColor.r, self.borderColor.g, self.borderColor.b)

    local title = "Your Safehouses"
    self:drawText(title,
        self.width / 2 - getTextManager():MeasureStringX(UIFont.Medium, title) / 2,
        UI_BORDER_SPACING + 1, 1, 1, 1, 1, UIFont.Medium)

    self.viewBtn.enable = self:selected() ~= nil
end

--[[
Open the stock safehouse panel on one particular claim.

Same call the admin panel's View button makes, down to the geometry - the only
difference is which safehouse is handed over.
]]
function WabbajackSafehousePicker:open(safehouse)
    if not safehouse then return end
    local width = 500 + getCore():getOptionFontSizeReal() * 30
    local ui = ISSafehouseUI:new((getCore():getScreenWidth() - width) / 2,
        getCore():getScreenHeight() / 2 - 225, width, 450, safehouse, self.player)
    ui:initialise()
    ui:addToUIManager()
end

function WabbajackSafehousePicker:onClick(button)
    if button.internal == "CLOSE" then
        self:close()
        return
    end
    if button.internal == "VIEW" then
        self:open(self:selected())
    end
end

function WabbajackSafehousePicker:onDoubleClick(safehouse)
    self:open(safehouse)
end

function WabbajackSafehousePicker:close()
    self:setVisible(false)
    self:removeFromUIManager()
    WabbajackSafehousePicker.instance = nil
end

-- Quitting one is a safehouse change, so the list behind the panel has to
-- follow it. ISSafehouseUI closes itself on the same event when its own claim
-- disappears; this only has to drop the row.
Events.OnSafehousesChanged.Add(function()
    if WabbajackSafehousePicker.instance then
        WabbajackSafehousePicker.instance:populateList()
    end
end)

--[[
The hook.

The button holds whatever ISUserPanelUI.onOptionMouseDown was at the moment the
panel was built, and panels are built when the player opens them - long after
this file has loaded - so replacing the field is enough and no existing button
is left pointing at the old function.

Vanilla is called for every other button and for the single-safehouse case, so
if this hook is ever the thing that breaks, deleting the file restores stock
behaviour exactly.
]]
if ISUserPanelUI then
    local vanillaOnOptionMouseDown = ISUserPanelUI.onOptionMouseDown

    function ISUserPanelUI:onOptionMouseDown(button, x, y)
        if button.internal == "SAFEHOUSEPANEL" then
            local mine = safehousesOf(self.player)
            if #mine > 1 then
                if WabbajackSafehousePicker.instance then
                    WabbajackSafehousePicker.instance:close()
                end
                local ui = WabbajackSafehousePicker:new(self.player)
                ui:initialise()
                ui:addToUIManager()
                return
            end
        end
        return vanillaOnOptionMouseDown(self, button, x, y)
    end
else
    log("ISUserPanelUI is missing - the safehouse picker is not installed")
end
