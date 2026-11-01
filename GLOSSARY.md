# Daily Check-in

A private board where an invite-only group of friends says whether they will be online for tonight's video game session, so nobody has to chase anyone for an answer.

## Language

### People

**Group**:
A set of friends who play together and share one Board. A person may belong to several Groups.
_Avoid_: Team, server, party, clan

**Member**:
A person with a login to the app. A Member may belong to several Groups, or to none.
_Avoid_: User, player, account

**Display Name**:
An optional name a Member chooses to be shown by instead of their username. Logging in still uses the username.
_Avoid_: Nickname, alias, handle

**Owner**:
The one Member of a Group who invites or removes Members and sets the Game On Threshold. The creator starts as Owner and can hand ownership to another Member.
_Avoid_: Admin, leader, host

**Invite**:
The Owner's single-use offer for one person to join a Group, either as a new Member or as an existing one.
_Avoid_: Request, join code

**Password Reset Link**:
A one-time link that an Owner of one of the Member's Groups, or the Operator, generates so the Member can set a new password. Unrelated to the Reset.
_Avoid_: Reset, recovery link

**Setup Link**:
A one-time link the Operator generates so a person can create a login without joining any Group. It is how the very first Member gets in.
_Avoid_: Invite, sign-up link

**Operator**:
The person who deploys and runs the app. Acts from outside the app rather than through a Member's login, for example to let a locked-out Owner back in.
_Avoid_: Admin, superuser, host

### Availability

**Game Night**:
The single evening session a Check-in counts for: the next evening coming up, lasting until the Reset the following morning. Shown to Members as "Tonight".
_Avoid_: Session, the following night

**Check-in**:
A Member's declaration of their Availability for the current Game Night, optionally with a Note. One Check-in shows on every Board the Member belongs to.
_Avoid_: RSVP, status, vote

**Availability**:
The answer in a Check-in: Yes, No, or Maybe.
_Avoid_: Status, response

**Note**:
Optional short free text on a Check-in that qualifies the answer, such as "on after 10".
_Avoid_: Comment, message

**Board**:
The view of one Group for the current Game Night: every Member, with their Check-in or "no answer yet".
_Avoid_: List, dashboard, roster

**Reset**:
The fixed early-morning moment, the same for every Group, when one Game Night ends and the next begins. Every Board starts empty and the ended Game Night moves to History.
_Avoid_: Rollover, midnight

**History**:
The record of a Group's past Game Nights and the Check-ins each one had.
_Avoid_: Archive, log, past Boards

### Game On

**Game On Threshold**:
The number of Yes Check-ins a Group needs for its Game Night to be on. Maybe does not count.
_Avoid_: Quorum, minimum players

**Game On**:
The state of a Group's Game Night once its Yes count reaches the Game On Threshold.
_Avoid_: Confirmed, happening

**Game Off**:
The state of a Group's Game Night when its Yes count drops back below the Game On Threshold after it was Game On.
_Avoid_: Cancelled, called off

### Notifications

**Reminder**:
A notification to a Member who has not checked in for tonight yet.
_Avoid_: Nudge, ping

**Daily Summary**:
One notification per Group per Game Night listing every Member's Availability.
_Avoid_: Digest, report
