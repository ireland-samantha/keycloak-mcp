package io.github.irelandsamantha.keycloakmcp.equivalence.fixtures;

import org.keycloak.admin.client.resource.OrganizationGroupResource;
import org.keycloak.admin.client.resource.OrganizationResource;
import org.keycloak.representations.idm.OrganizationDomainRepresentation;
import org.keycloak.representations.idm.OrganizationRepresentation;

import java.util.List;

/**
 * An organization with a domain, the seeded user as member, the seeded identity provider linked, a group with a
 * subgroup, a member and a role mapping, and a pending invitation.
 */
final class OrganizationSeeding {

    static final String INVITEE = "invitee@" + RealmSeeder.DOMAIN;

    private OrganizationSeeding() {
    }

    static void seed(Seeding s) {
        s.step(SeededRealm.ORG_ID, () -> Seeding.created(s.realm.organizations().create(organization())));
        s.step(SeededRealm.ORG_MEMBER, () -> {
            Seeding.ensure2xx(org(s).members().addMember(s.id(SeededRealm.USER_ID)));
            return s.id(SeededRealm.USER_ID);
        });
        s.run("organization identity provider", () -> Seeding.ensure2xx(org(s).identityProviders().addIdentityProvider(s.id(SeededRealm.IDP))));
        s.step(SeededRealm.ORG_GROUP_ID, () -> Seeding.created(org(s).groups().addTopLevelGroup(RoleAndGroupSeeding.group(RealmSeeder.ORG_GROUP))));
        s.run("organization group contents", () -> {
            OrganizationGroupResource group = org(s).groups().group(s.id(SeededRealm.ORG_GROUP_ID));
            Seeding.ensure2xx(group.addSubGroup(RoleAndGroupSeeding.group(RealmSeeder.ORG_GROUP + "-child")));
            group.addMember(s.id(SeededRealm.ORG_MEMBER));
            group.roles().realmLevel().add(List.of(s.realm.roles().get(RealmSeeder.ROLE).toRepresentation()));
        });
        // The invitation is stored only if its mail goes out (OrganizationInvitationResource.java:184-205).
        s.step(SeededRealm.INVITATION_ID, () -> {
            Seeding.ensure2xx(org(s).members().inviteUser(INVITEE, "Seed", "Invitee"));
            return org(s).invitations().list().getFirst().getId();
        });
    }

    private static OrganizationResource org(Seeding s) {
        return s.realm.organizations().get(s.id(SeededRealm.ORG_ID));
    }

    private static OrganizationRepresentation organization() {
        OrganizationRepresentation org = new OrganizationRepresentation();
        org.setName("seed-org");
        org.setAlias("seed-org");
        OrganizationDomainRepresentation domain = new OrganizationDomainRepresentation();
        domain.setName(RealmSeeder.DOMAIN);
        org.addDomain(domain);
        return org;
    }
}
