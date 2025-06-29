---
title: People
permalink: /people/
---

{% assign people_sorted = site.people | sort: 'joined' %}
{% assign role_array = "pi|postdoc|gradstudent|researchstaff|visiting|others|undergraduate|alumni" | split: "|" %}

{% for role in role_array %}

{% assign people_in_role = people_sorted | where: 'position', role %}

<!-- Skip section if there's nobody -->
{% if people_in_role.size == 0 %}
  {% continue %}
{% endif %}

<div class="pos_header">
{% if role == 'postdoc' %}
<h3>Postdoctoral Fellows</h3>
 {% elsif role == 'pi' %}
<h3>Principal Investigator</h3>
 {% elsif role == 'gradstudent' %}
<h3>Graduate Students</h3>
 {% elsif role == 'researchstaff' %}
<h3>Research Staff</h3>
 {% elsif role == 'visiting' %}
<h3>Visiting Scholars</h3>
 {% elsif role == 'others' %}
<h3>Honorary Members</h3>
{% elsif role == 'undergraduate' %}
<h3>Undergraduate Students</h3>
 {% elsif role == 'alumni' %}
<h3>Alumni</h3>
{% endif %}
</div>

{% if role != 'alumni' %}
<div class="content list people">
  {% for profile in people_sorted %}
    {% if profile.position contains role %}
      <div class="list-item-people">
        <p class="list-post-title">
          {% if profile.avatar %}
            <a href="{{ site.baseurl }}{{ profile.url }}"><img class="profile-thumbnail" src="{{site.baseurl}}/images/people/{{profile.avatar}}"></a>
          {% else %}
            <a href="{{ site.baseurl }}{{ profile.url }}"><img class="profile-thumbnail" src="http://evansheline.com/wp-content/uploads/2011/02/facebook-Storm-Trooper.jpg"></a>
          {% endif %}
          <a class="name" href="{{ site.baseurl }}{{ profile.url }}">{{ profile.name }}</a>
        </p>
      </div>
    {% endif %}
  {% endfor %}
</div>
<hr>

{% else %}

<br>

| Who are they | When were they here | Where they went |
| :------------- |:-------------| :-----------|
| [Nick Strohmeyer](https://www.linkedin.com/in/nick-strohmeyer-209a3a157/) | MS student in ECE (2022-2024) | MITRE |
| [Antonio Lopez](https://mx.linkedin.com/in/antonio-lopez-guzman-55a060213) | MS student in ASE (2022-2024) | Pacific Northwest National Lab |
| [Andriy Malyshchak](https://www.linkedin.com/in/andriy-malyshchak-a19709232) | Undergraduate student in ECE (2022-2023) | Texas Robotics
| [Jonathan Salfity](https://www.linkedin.com/in/jsalfity) | PhD student in ME (2021-2023) | PhD student with [NRG](https://robotics.me.utexas.edu) |
| [Junette Hsin](https://junettehsin.com) | MS student in ASE (2022-2023) | PhD student in [HCRL](https://sites.utexas.edu/hcrl/) |
| [Vincent Spada](https://www.linkedin.com/in/vincent-spada-6450a3234/) | Undergraduate student in ASE (2023)| Flight dynamics, NASA Langley |
| [Tyler Westenbroek](https://tyler-westenbroek.github.io) | Postdoc in Oden Institute (2023) | Postdoc in CS at UW |
| [Bryant Zhou](https://www.linkedin.com/in/yujing-zhou-938962151) | MS student in ME (2021-2022) | PhD student in MAE at Princeton |

{% endif %}
{% endfor %}
