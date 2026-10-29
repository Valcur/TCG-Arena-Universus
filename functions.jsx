async function check() {
    const deck = await functions.getDeck()
    const deckLength = deck?.length ?? 0
    if (deckLength === 0) return

    const topCard = deck[deckLength - 1]
    const topCardData = functions.getCardData(topCard)

    const checkValue = topCardData?.check ?? 0
    game.data.Manager.checkValue = checkValue
    game.data.Manager.checkKey++
    functions.chatLog("Checked a value of " + checkValue)

    await functions.draw(1, false, "Discard")
}

async function onPlayersReady() {
    if (!cards.Character?.length > 0) return
    const characterCard = cards.Character[0]
    const characterCardData = functions.getCardData(characterCard)
    game.data.Manager.handSize = characterCardData.handSize ?? 0
    game.data.Manager.vitality = characterCardData.vitality ?? 0

    await functions.changeCounterValue(0, game.data.Manager.vitality)
    await functions.draw(game.data.Manager.handSize)
}