You have the floor in meeting {{meetingId}}.

Agenda: {{agenda}}

Last said — {{last}}

Answer now, briefly, and only about the agenda. Reply as a normal message to
`agent.odeon`; the driver records it and passes the floor on.

**If you have nothing to add, do not say so in a turn — decline the floor.**
Answer `agent.odeon` with `act: "refuse"` and one line of reason. A turn that
says "nothing further" is still a turn: it goes into the minutes and it tells
the meeting the room is still talking, so the floor comes back to you and you
are asked again. A declined floor is recorded as a decline, adds nothing to the
minutes, and when everyone present has declined without anything being said the
meeting adjourns itself.
